# Piqued

Piqued is a query compiler for postgres & a language server. The goal of piqued is to enable developers to write queries in a natural (postgres-y) way, while still giving them the full power of typechecking and some of the good functionality an ORM provides.

⚠️⚠️⚠️ **This is a work in progress** ⚠️⚠️⚠️

Piqued is not even remotely stable. I'm building the boat as I set sail so that I can more easily understand the way it should work. If you want to work on it, I'd love the help but please do not use this for anything real yet.

## Install

You can install the binaries by running

```bash
https://raw.githubusercontent.com/zwade/piqued/refs/heads/master/rust/piqued/scripts/install.sh | bash
```

And you can add the client by installing

```bash
npm i @piqued/client
yarn add @piqued/client
```

## Features

- 🛠️ Query Compiling
- 🕵️‍♂️ Typechecking
- 🧩 Custom Type Parsing
- 🖥️ Language Server

## Examples

```sql
-- @params user_id
PREPARE get_user (int) AS
    SELECT "user" FROM "user" WHERE id=$1;
```

```ts
import userQueries from "./userQueries";
import pg from "pg";

const pool = new pg.Pool()
const queries = userQueries(pool);

queries
    .getUser({ userId: 2 })
    .one()
    .then(({ user: { name, email } }) => console.log(name, email));
```

## Author(s)

Just me for now! [@zwade](https://github.com/zwade)/[@zwad3](https://twitter.com/zwad3)