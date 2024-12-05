PREPARE reflect AS
    SELECT $1::text || ' from postgres!' AS input;

-- @name reflect_2
-- @params first second
SELECT $1::text || ' from another postgres!', $2 AS input;

SELECT 'This query has messy characters: \ ` ''';

-- @name ppl
SELECT person, practice,
FROM person pe
INNER JOIN practice_person_patient ppp
    ON ppp.person_uid = pe.uid
INNER JOIN practice pr
    ON pr.name