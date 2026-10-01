#!/usr/bin/env bash
# Runs once, on first Postgres container start (docker-entrypoint-initdb.d).
# Creates the shadow database Prisma Migrate uses for drift detection.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	SELECT 'CREATE DATABASE orbitoz_db_shadow OWNER ' || current_user
	WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'orbitoz_db_shadow')\gexec
SQL

echo "[orbitoz] shadow database ready"
