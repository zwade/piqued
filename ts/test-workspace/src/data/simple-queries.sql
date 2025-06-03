PREPARE reflect AS
    SELECT $1::text || ' from postgres!' AS input;

-- @name reflect_2
-- @params first second
SELECT $1::text || ' from another postgres!', $2 AS input;

SELECT 'This query has messy characters: \ ` ''';

-- @params force
-- @xtemplate uids (uuid_generate_v4())
PREPARE test AS
    SELECT first_name FROM person
    WHERE
        uid IN :uids OR
        :force;

PREPARE several AS
    SELECT unnest('{1,2,3,4,5,6,7,8,9}'::int[]) as num;

PREPARE get_practices AS
    SELECT array_agg(practice)
    FROM practice;