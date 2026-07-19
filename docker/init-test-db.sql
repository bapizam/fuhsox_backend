-- This script runs automatically when the PostgreSQL container starts.
-- It creates the test database alongside the main development database.

CREATE DATABASE fuhsox_test;
GRANT ALL PRIVILEGES ON DATABASE fuhsox_test TO fuhsox;
