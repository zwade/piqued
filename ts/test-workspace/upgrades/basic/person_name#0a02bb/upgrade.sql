 -- File: upgrade.sql
 -- Version: person_name#0a02bb
 -- Parents: test-data#159874

ALTER TABLE person
    ADD COLUMN first_name TEXT,
    ADD COLUMN last_name TEXT;