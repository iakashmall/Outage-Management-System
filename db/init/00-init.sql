-- Runs automatically on FIRST boot of a fresh Postgres volume.
-- Creates the Keycloak database and enables the extensions the OMS uses.

SELECT 'CREATE DATABASE keycloak'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec

\connect oms
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

SELECT 'PostGIS ' || postgis_version();
SELECT extname FROM pg_extension ORDER BY extname;
