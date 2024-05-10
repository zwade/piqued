PREPARE reflect AS
    SELECT $1::text || ' from postgres!' AS input;

-- @name reflect_2
-- @params first second
SELECT $1::text || ' from another postgres!', $2 AS input;

SELECT 'This query has messy characters: \ ` ''';

SELECT * from company;
