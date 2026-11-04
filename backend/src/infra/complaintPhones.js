// Complaint phone storage, made part of migrate() (runbook v2 follow-up).
// Until now it lived only in the manual db/migrations/encrypt_phone_at_rest.sql
// and safe_decrypt_phone.sql, which a database migrated by migrate() alone
// (CI, the server) never got: every complaint read then failed with
// "function safe_decrypt_text(text, unknown) does not exist".
// Idempotent; safe on every boot:
//   1. CREATE EXTENSION IF NOT EXISTS pgcrypto      (pgp_sym_encrypt / decrypt)
//   2. safe_decrypt_text(bytea, text)  -- same as safe_decrypt_phone.sql
//      safe_decrypt_text(text, text)   -- for a phone column still TEXT: an
//        encrypted value stored as hex text ('\x...') is decrypted, anything
//        else is legacy plain text and returned as it is
//   3. complaints.phone TEXT -> BYTEA, the end state of encrypt_phone_at_rest.sql,
//      only when ENCRYPTION_KEY is set: '\x...' hex text (already encrypted by
//      addComplaint) is decoded, never encrypted twice; plain text is encrypted
//      with ENCRYPTION_KEY. Without the key the column stays TEXT (still readable).
// After this, the two manual files are no-ops ("already encrypted").
import { db } from './db.js';

export async function migrateComplaintPhones(cx = db) {
  await cx.none(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE OR REPLACE FUNCTION safe_decrypt_text(data bytea, key text)
    RETURNS text AS $$
    BEGIN
      RETURN pgp_sym_decrypt(data, key);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'safe_decrypt_text: could not decrypt a row (%), returning NULL', SQLERRM;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
    CREATE OR REPLACE FUNCTION safe_decrypt_text(data text, key text)
    RETURNS text AS $$
    BEGIN
      IF data IS NULL THEN RETURN NULL; END IF;
      IF data ~ '^\\\\x[0-9a-fA-F]+$' THEN
        RETURN pgp_sym_decrypt(decode(substr(data, 3), 'hex'), key);
      END IF;
      RETURN data;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'safe_decrypt_text: could not decrypt a row (%), returning NULL', SQLERRM;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);

  const col = await cx.oneOrNone(`SELECT data_type FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'complaints' AND column_name = 'phone'`);
  if (!col || col.data_type === 'bytea') return { phone: col?.data_type || 'missing', converted: false };
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    console.warn('[migrate] complaints.phone is still TEXT and ENCRYPTION_KEY is not set: phones are not encrypted at rest. Set ENCRYPTION_KEY and restart to convert.');
    return { phone: col.data_type, converted: false };
  }
  await cx.tx('complaint-phones', async (t) => {
    // The key reaches the USING clause through a transaction-local setting.
    await t.one("SELECT set_config('oms.phone_key', $1, true)", [key]);
    await t.none(`ALTER TABLE complaints ALTER COLUMN phone TYPE bytea USING (
      CASE WHEN phone IS NULL THEN NULL
           WHEN phone ~ '^\\\\x[0-9a-fA-F]+$' THEN decode(substr(phone, 3), 'hex')
           ELSE pgp_sym_encrypt(phone, current_setting('oms.phone_key')) END)`);
  });
  console.log('[migrate] complaints.phone converted to encrypted BYTEA');
  return { phone: 'bytea', converted: true };
}
