pub fn to_camel_case(identifier: &String, pascal_mode: bool) -> String {
    let mut chars: Vec<char> = vec![];

    let mut capitalize_next = pascal_mode;
    for char_ in identifier.chars() {
        if char_ == '_' {
            capitalize_next = true;
            continue;
        }

        if char_.is_alphanumeric() {
            if capitalize_next {
                chars.push(char_.to_ascii_uppercase());
                capitalize_next = false;
            } else {
                chars.push(char_);
            }
        }
    }

    chars.iter().collect()
}

pub fn to_snake_case(identifier: &String) -> String {
    let mut chars: Vec<char> = vec![];

    let mut has_pending_underscore = false;
    for char_ in identifier.chars() {
        if char_ == '_' {
            has_pending_underscore = true;
            continue;
        }

        if !char_.is_alphanumeric() {
            continue;
        }

        if char_.is_uppercase() {
            if has_pending_underscore {
                chars.push('_');
                has_pending_underscore = false;
            }
            chars.push(char_.to_ascii_lowercase())
        }
    }

    chars.iter().collect()
}

pub fn indent_block(block: &String, indent: usize) -> String {
    let mut lines: Vec<String> = vec![];
    for line in block.lines() {
        lines.push(format!("{}{}", " ".repeat(indent * 4), line));
    }

    if block.ends_with("\n") {
        lines.push("".to_string());
    }

    lines.join("\n")
}
