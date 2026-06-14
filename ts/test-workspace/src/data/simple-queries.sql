PREPARE reflect AS
    SELECT $1::text || ' from postgres!' AS input;

-- @name reflect_2
-- @params first second
SELECT $1::text || ' from another postgres!', $2 AS input;

SELECT 'This query has messy characters: \ ` ''';

PREPARE several AS
    SELECT unnest('{1,2,3,4,5,6,7,8,9}'::int[]) as num;

PREPARE select_array AS
    SELECT unnest($1::int[]) AS num;

-- @fragment test_frag
SELECT 'hello world';

-- @name use_frag
SELECT * FROM (:test_frag) sq;