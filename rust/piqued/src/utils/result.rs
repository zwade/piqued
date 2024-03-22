use core::fmt;

#[derive(Debug, Eq, PartialEq, Clone)]
pub enum PiquedError {
    ParseErrorAt(String),
    PostgresError(String),
    OtherError(String),
    SerdeParseError(toml::de::Error),
}

impl fmt::Display for PiquedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({:#?})", self)
    }
}

impl From<pg_query::Error> for PiquedError {
    fn from(err: pg_query::Error) -> Self {
        match err {
            pg_query::Error::Parse(str) => {
                if str.starts_with("syntax error at or near \"") {
                    let location = str
                        .trim_start_matches("syntax error at or near \"")
                        .split("\"")
                        .next();

                    match location {
                        Some(data) => Self::ParseErrorAt(data.to_string()),
                        None => Self::OtherError(str),
                    }
                } else {
                    Self::OtherError(str)
                }
            }
            _ => Self::OtherError(format!("{:#?}", err)),
        }
    }
}

impl From<std::io::Error> for PiquedError {
    fn from(err: std::io::Error) -> Self {
        PiquedError::OtherError(format!("{:#?}", err))
    }
}

impl From<tokio_postgres::Error> for PiquedError {
    fn from(err: tokio_postgres::Error) -> Self {
        match err.as_db_error() {
            None => PiquedError::OtherError(format!("{:#?}", err)),
            Some(db_err) => PiquedError::PostgresError(db_err.message().to_string()),
        }
    }
}

impl From<toml::de::Error> for PiquedError {
    fn from(value: toml::de::Error) -> Self {
        PiquedError::SerdeParseError(value)
    }
}

pub type Result<T> = core::result::Result<T, PiquedError>;
