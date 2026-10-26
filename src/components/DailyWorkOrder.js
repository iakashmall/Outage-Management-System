// src/components/DailyWorkOrder.js
// The crew's daily work order (OMS-03), the "Today" tab: start the day
// (crew members and start-of-day checks), work through the day's jobs in
// order, and end the day (why each unfinished job carries over, remarks,
// crew-lead sign-off). Rules and payloads are in lib/workOrder.js; the
// parent (NativeApp.jsx) sends them, or queues them without signal.
import { useMemo, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import CrewLeadSignOff from "./CrewLeadSignOff";
import {
  START_CHECKS,
  CARRY_REASONS,
  carryReasonLabel,
  dayJobs,
  summarize,
  formatMinutes,
  canStart,
  missingReasons,
} from "../lib/workOrder";

const STATUS_TEXT = { not_started: "Not started", started: "In progress", closed: "Day ended" };
const STATUS_COLOR = { not_started: "#b26a00", started: "#1d7a46", closed: "#5b6b80" };

const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const dateText = (date) => new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

export default function DailyWorkOrder({ crew, jobs, date, workOrder, lastMembers, busy, onStart, onEnd, onOpenJob }) {
  const [mode, setMode] = useState("view"); // view | start | end
  const day = useMemo(() => dayJobs(jobs, date), [jobs, date]);
  const summary = summarize(day);
  const status = workOrder?.status || "not_started";

  if (mode === "start") {
    return (
      <StartDay
        crew={crew}
        lastMembers={lastMembers}
        busy={busy}
        onCancel={() => setMode("view")}
        onSubmit={async (form) => { if (await onStart(form)) setMode("view"); }}
      />
    );
  }
  if (mode === "end") {
    return (
      <EndDay
        crew={crew}
        open={day.open}
        summary={summary}
        busy={busy}
        onCancel={() => setMode("view")}
        onSubmit={async (form) => { if (await onEnd(form)) setMode("view"); }}
      />
    );
  }

  const pct = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  return (
    <View>
      <Text style={s.h1}>Today&apos;s work order</Text>
      <Text style={s.sub}>{dateText(date)} · {workOrder?.id}</Text>

      <View style={s.card}>
        <View style={s.rowBetween}>
          <View style={[s.pill, { backgroundColor: STATUS_COLOR[status] }]}>
            <Text style={s.pillText}>{STATUS_TEXT[status]}</Text>
          </View>
          {workOrder?.pendingSync ? <Text style={s.pendingSync}>Waiting to sync</Text> : null}
        </View>
        {status !== "not_started" ? (
          <Text style={s.meta}>
            Started {timeOf(workOrder.started_at)}
            {status === "closed" ? ` · Ended ${timeOf(workOrder.closed_at)}` : ""}
          </Text>
        ) : null}
        {Array.isArray(workOrder?.members) && workOrder.members.length ? (
          <Text style={s.meta}>Crew: {workOrder.members.join(", ")}</Text>
        ) : null}

        <Text style={s.progressText}>{summary.done} of {summary.total} jobs done</Text>
        <View style={s.barTrack}>
          <View style={[s.barFill, { width: `${pct}%` }]} />
        </View>
        {summary.open ? <Text style={s.meta}>About {formatMinutes(summary.estRemainingMin)} of work left</Text> : null}

        {status === "not_started" ? (
          <>
            <Text style={s.hint}>Start your day before heading out: confirm who is on the crew and the vehicle and safety checks.</Text>
            <Pressable style={s.primary} onPress={() => setMode("start")} accessibilityRole="button">
              <Text style={s.primaryText}>Start day</Text>
            </Pressable>
          </>
        ) : status === "started" ? (
          <Pressable style={s.secondary} onPress={() => setMode("end")} accessibilityRole="button">
            <Text style={s.secondaryText}>End day</Text>
          </Pressable>
        ) : null}
      </View>

      {status === "closed" ? <DayReport workOrder={workOrder} /> : null}

      <Text style={s.section}>TO DO ({day.open.length})</Text>
      {!day.open.length ? <Text style={s.empty}>Nothing left to do today.</Text> : null}
      {day.open.map((job, i) => (
        <JobRow key={job.id} n={i + 1} job={job} onPress={() => onOpenJob(job)} />
      ))}

      <Text style={s.section}>DONE TODAY ({day.done.length})</Text>
      {!day.done.length ? <Text style={s.empty}>No jobs finished yet today.</Text> : null}
      {day.done.map((job) => (
        <JobRow key={job.id} job={job} done onPress={() => onOpenJob(job)} />
      ))}
    </View>
  );
}

function JobRow({ n, job, done, onPress }) {
  return (
    <Pressable style={({ pressed }) => [s.jobRow, pressed && { opacity: 0.7 }]} onPress={onPress} accessibilityRole="button">
      <View style={[s.jobNum, done && s.jobNumDone]}>
        <Text style={s.jobNumText}>{done ? "✓" : n}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.rowBetween}>
          <Text style={s.jobId}>{job.id}</Text>
          <Text style={s.jobStatus}>{job.status}</Text>
        </View>
        <Text style={s.jobTitle} numberOfLines={1}>{job.title}</Text>
        <Text style={s.meta} numberOfLines={1}>
          {[job.priority && `${job.priority}${job.medical ? " (Medical)" : ""}`, job.estimatedDurationMin && `Est. ${job.estimatedDurationMin} min`, job.address]
            .filter(Boolean).join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
}

function DayReport({ workOrder }) {
  const carried = workOrder.close_snapshot?.carriedOver || [];
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>End-of-day report</Text>
      {carried.length ? (
        carried.map((c) => (
          <Text key={c.jobId} style={s.meta}>
            {c.jobId} carried over: {carryReasonLabel(c.reason)}{c.note ? ` (${c.note})` : ""}
          </Text>
        ))
      ) : (
        <Text style={s.meta}>No jobs carried over.</Text>
      )}
      {workOrder.close_remarks ? <Text style={s.meta}>Remarks: {workOrder.close_remarks}</Text> : null}
      {workOrder.close_sign_off?.name ? <Text style={s.meta}>Signed off by {workOrder.close_sign_off.name}</Text> : null}
    </View>
  );
}

function CheckRow({ label, on, onPress }) {
  return (
    <Pressable style={s.checkRow} onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <View style={[s.box, on && s.boxOn]}>{on ? <Text style={s.tick}>✓</Text> : null}</View>
      <Text style={s.checkLabel}>{label}</Text>
    </Pressable>
  );
}

function StartDay({ crew, lastMembers, busy, onCancel, onSubmit }) {
  const initial = lastMembers?.length ? lastMembers : [crew?.lead].filter(Boolean);
  const [members, setMembers] = useState(initial.length ? initial : [""]);
  const [checks, setChecks] = useState({});
  const [note, setNote] = useState("");
  const ready = canStart({ members, checks }) && !busy;

  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Start day</Text>
      <Text style={s.label}>CREW ON DUTY TODAY</Text>
      {members.map((m, i) => (
        <View key={i} style={s.memberRow}>
          <TextInput
            style={[s.input, { flex: 1 }]}
            value={m}
            onChangeText={(v) => setMembers((list) => list.map((x, j) => (j === i ? v : x)))}
            placeholder={i === 0 ? "Crew lead" : "Crew member"}
            placeholderTextColor="#9aa8bb"
          />
          {members.length > 1 ? (
            <Pressable style={s.removeBtn} onPress={() => setMembers((list) => list.filter((_, j) => j !== i))} accessibilityLabel="Remove crew member">
              <Text style={s.removeText}>×</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {members.length < 20 ? (
        <Pressable onPress={() => setMembers((list) => [...list, ""])}>
          <Text style={s.link}>+ Add crew member</Text>
        </Pressable>
      ) : null}

      <Text style={s.label}>START-OF-DAY CHECKS</Text>
      {START_CHECKS.map((c) => (
        <CheckRow key={c.key} label={c.label} on={!!checks[c.key]} onPress={() => setChecks((v) => ({ ...v, [c.key]: !v[c.key] }))} />
      ))}

      <Text style={s.label}>NOTE (OPTIONAL)</Text>
      <TextInput style={[s.input, s.multiline]} value={note} onChangeText={setNote} multiline placeholder="e.g. vehicle low on fuel, refuelling at depot" placeholderTextColor="#9aa8bb" />

      <View style={s.navRow}>
        <Pressable style={s.backBtn} onPress={onCancel}>
          <Text style={s.backBtnText}>Back</Text>
        </Pressable>
        <Pressable style={[s.nextBtn, !ready && s.nextBtnOff]} disabled={!ready} onPress={() => onSubmit({ members, checks, note })}>
          <Text style={s.nextBtnText}>{busy ? "Starting…" : "Start day"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function EndDay({ crew, open, summary, busy, onCancel, onSubmit }) {
  const [step, setStep] = useState("report"); // report | signoff
  const [reasons, setReasons] = useState({});
  const [notes, setNotes] = useState({});
  const [remarks, setRemarks] = useState("");
  const missing = missingReasons(open, reasons);

  if (step === "signoff") {
    return (
      <CrewLeadSignOff
        defaultName={crew?.lead || ""}
        confirmText="I confirm this end-of-day report is correct and every crew member is accounted for."
        submitLabel={busy ? "Ending day…" : "Sign off & end day"}
        onCancel={() => setStep("report")}
        onComplete={(signOff) => onSubmit({ open, reasons, notes, remarks, signOff })}
      />
    );
  }
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>End day</Text>
      <Text style={s.meta}>{summary.done} of {summary.total} jobs done today.</Text>
      {open.length ? (
        <>
          <Text style={s.label}>WHY IS EACH OPEN JOB CARRIED OVER?</Text>
          {open.map((job) => (
            <View key={job.id} style={s.carryBlock}>
              <Text style={s.jobId}>{job.id} · {job.status}</Text>
              <Text style={s.meta} numberOfLines={1}>{job.title}</Text>
              <View style={s.chips}>
                {CARRY_REASONS.map((r) => {
                  const on = reasons[job.id] === r.value;
                  return (
                    <Pressable key={r.value} style={[s.chip, on && s.chipOn]} onPress={() => setReasons((v) => ({ ...v, [job.id]: r.value }))}>
                      <Text style={[s.chipText, on && s.chipTextOn]}>{r.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {reasons[job.id] === "other" ? (
                <TextInput style={s.input} value={notes[job.id] || ""} onChangeText={(v) => setNotes((n) => ({ ...n, [job.id]: v }))} placeholder="What is holding it up?" placeholderTextColor="#9aa8bb" />
              ) : null}
            </View>
          ))}
        </>
      ) : (
        <Text style={s.meta}>Every job is done.</Text>
      )}
      <Text style={s.label}>REMARKS (OPTIONAL)</Text>
      <TextInput style={[s.input, s.multiline]} value={remarks} onChangeText={setRemarks} multiline placeholder="Anything the control room should know for tomorrow" placeholderTextColor="#9aa8bb" />
      {missing.length ? <Text style={s.warn}>Pick a reason for {missing.map((j) => j.id).join(", ")}.</Text> : null}
      <View style={s.navRow}>
        <Pressable style={s.backBtn} onPress={onCancel}>
          <Text style={s.backBtnText}>Back</Text>
        </Pressable>
        <Pressable style={[s.nextBtn, missing.length > 0 && s.nextBtnOff]} disabled={missing.length > 0} onPress={() => setStep("signoff")}>
          <Text style={s.nextBtnText}>Next: sign off</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  h1: { fontSize: 22, fontWeight: "800", color: "#0f1b2d" },
  sub: { fontSize: 13, color: "#7c8da3", marginTop: 2, marginBottom: 12 },
  card: { padding: 16, backgroundColor: "#fff", borderRadius: 12, gap: 10, borderWidth: 1, borderColor: "#e6ecf3", marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: "800", color: "#1F3864" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { color: "#fff", fontWeight: "800", fontSize: 12 },
  pendingSync: { fontSize: 12, fontWeight: "700", color: "#b26a00" },
  meta: { fontSize: 13, color: "#33465f" },
  hint: { fontSize: 13, color: "#33465f", lineHeight: 18 },
  progressText: { fontSize: 15, fontWeight: "800", color: "#0f1b2d", marginTop: 4 },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: "#e6ecf3", overflow: "hidden" },
  barFill: { height: 8, backgroundColor: "#1d7a46" },
  primary: { backgroundColor: "#1F3864", padding: 13, borderRadius: 8, alignItems: "center", marginTop: 4 },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  secondary: { borderWidth: 1.5, borderColor: "#1F3864", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 4 },
  secondaryText: { color: "#1F3864", fontWeight: "800", fontSize: 15 },
  section: { fontSize: 12, fontWeight: "800", color: "#7c8da3", letterSpacing: 0.6, marginTop: 10, marginBottom: 8 },
  empty: { fontSize: 13, color: "#7c8da3", marginBottom: 8 },
  jobRow: { flexDirection: "row", gap: 12, alignItems: "center", padding: 12, backgroundColor: "#fff", borderRadius: 10, borderWidth: 1, borderColor: "#e6ecf3", marginBottom: 8 },
  jobNum: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#1F3864", alignItems: "center", justifyContent: "center" },
  jobNumDone: { backgroundColor: "#1d7a46" },
  jobNumText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  jobId: { fontSize: 13, fontWeight: "800", color: "#0f1b2d" },
  jobStatus: { fontSize: 12, fontWeight: "700", color: "#1F3864" },
  jobTitle: { fontSize: 14, color: "#0f1b2d", marginTop: 2 },
  label: { fontSize: 11, fontWeight: "800", color: "#7c8da3", letterSpacing: 0.5, marginTop: 6 },
  input: { borderWidth: 1.5, borderColor: "#c7d0dc", borderRadius: 8, padding: 10, fontSize: 14, color: "#0f1b2d" },
  multiline: { minHeight: 64, textAlignVertical: "top" },
  memberRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  removeBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: "#c7d0dc" },
  removeText: { fontSize: 20, color: "#7c8da3" },
  link: { color: "#1F3864", fontWeight: "800", fontSize: 14, paddingVertical: 4 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  box: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: "#1F3864", alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: "#1F3864" },
  tick: { color: "#fff", fontSize: 12, fontWeight: "800" },
  checkLabel: { flex: 1, fontSize: 14, color: "#0f1b2d" },
  carryBlock: { gap: 6, paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#eef2f7" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: "#c7d0dc", backgroundColor: "#fff" },
  chipOn: { backgroundColor: "#1F3864", borderColor: "#1F3864" },
  chipText: { fontSize: 12, color: "#33465f", fontWeight: "600" },
  chipTextOn: { color: "#fff" },
  warn: { fontSize: 12, color: "#b26a00", fontWeight: "700" },
  navRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  backBtn: { flex: 1, alignItems: "center", padding: 11, borderRadius: 8, borderWidth: 1, borderColor: "#c7d0dc" },
  backBtnText: { color: "#7c8da3", fontWeight: "700" },
  nextBtn: { flex: 2, alignItems: "center", padding: 11, borderRadius: 8, backgroundColor: "#1F3864" },
  nextBtnOff: { backgroundColor: "#aab4c2" },
  nextBtnText: { color: "#fff", fontWeight: "800" },
});
