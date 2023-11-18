use string_builder::Builder;

pub struct CodeBuilder {
    pub completed: bool,
    indentation: usize,
    builder: Builder,
    pending_newline: bool,
    delimiter: String,
    indentation_delimiter: String,
}

impl CodeBuilder {
    pub fn new() -> Self {
        Self {
            indentation: 0,
            builder: Builder::default(),
            pending_newline: false,
            delimiter: "\n".to_string(),
            indentation_delimiter: "    ".to_string(),
            completed: false,
        }
    }

    pub fn indent(&mut self) {
        self.indentation += 1;
    }

    pub fn unindent(&mut self) {
        self.indentation -= 1;
    }

    pub fn write(&mut self, string: String) {
        if self.completed {
            panic!("CodeBuilder has already been completed");
        }

        let lines = string.split(self.delimiter.as_str()).collect::<Vec<&str>>();

        for (i, line) in lines.iter().enumerate() {
            self.handle_newline();
            self.builder.append(*line);

            if i != lines.len() - 1 {
                self.pending_newline = true;
            }
        }
    }

    pub fn writeln(&mut self, string: String) {
        self.write(string);
        self.pending_newline = true;
    }

    pub fn string(mut self) -> String {
        if self.pending_newline {
            self.builder.append(self.delimiter.as_str());
            self.pending_newline = false;
        }

        self.completed = true;
        self.builder.string().unwrap()
    }

    fn handle_newline(&mut self) {
        if self.pending_newline {
            self.builder.append(self.delimiter.as_str());
            self.builder
                .append(self.indentation_delimiter.repeat(self.indentation));
            self.pending_newline = false;
        }
    }
}
