 -- File: downgrade.sql
 -- Version: person_name#0a02bb
 -- Parents: test-data#159874

ALTER TABLE person
    DROP COLUMN first_name CASCADE,
    DROP COLUMN last_name CASCADE;