PREPARE reflect AS
    SELECT $1::text || ' from postgres!' AS input;

-- @name reflect_2
-- @params first second
SELECT $1::text || ' from another postgres!', $2 AS input;

SELECT 'This query has messy characters: \ ` ''';

-- @params force
-- @xtemplate uids (uuid_generate_v4())
PREPARE test AS
    SELECT name FROM person
    WHERE
        uid IN :uids OR
        $1;