//! Bounded English Moment-compatible formatting for the portable evaluator.
//! Obsidian delegates Date.format to Moment; this module implements that token
//! contract without executing JavaScript or depending on the process timezone.
use super::{BasesTimezone, DateValue};
use chrono::{Datelike, Duration, NaiveDate, Offset, TimeZone, Timelike};

pub(super) fn format(value: &DateValue, pattern: &str) -> Result<String, String> {
    if pattern.len() > 65_536 {
        return Err("budget\0Date format exceeds byte budget".into());
    }
    // The old adapter accepted parts of strftime accidentally. Do not pretend
    // those are Moment tokens; keep the explicit corpus diagnostic.
    render(
        value,
        if pattern.is_empty() {
            "YYYY-MM-DDTHH:mm:ssZ"
        } else {
            pattern
        },
        0,
    )
}

fn render(value: &DateValue, pattern: &str, depth: usize) -> Result<String, String> {
    if depth > 4 {
        return Err("budget\0Date format expansion exceeds depth budget".into());
    }
    let date = value.timezone.local_datetime(value.millis);
    let calendar = date.date();
    let month = date.month();
    let day = date.day();
    let weekday = date.weekday().num_days_from_sunday();
    let (week_year, week) = sunday_week(calendar);
    let iso_week = date.iso_week();
    let offset = match &value.timezone {
        BasesTimezone::Utc => 0,
        BasesTimezone::Fixed(offset) => offset.local_minus_utc(),
        BasesTimezone::Named(zone) => zone
            .offset_from_utc_datetime(
                &chrono::DateTime::<chrono::Utc>::from_timestamp_millis(value.millis)
                    .ok_or("invalid-local-time\0Invalid date instant")?
                    .naive_utc(),
            )
            .fix()
            .local_minus_utc(),
    };
    const MONTHS: [&str; 12] = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    const DAYS: [&str; 7] = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ];
    // Longest match wins, as Moment's formatting tokenizer does.
    const TOKENS: &[&str] = &[
        "YYYYYY",
        "YYYYY",
        "YYYY",
        "yyyy",
        "GGGG",
        "gggg",
        "DDDo",
        "DDDD",
        "MMMM",
        "dddd",
        "SSSSSSSSS",
        "SSSSSSSS",
        "SSSSSSS",
        "SSSSSS",
        "SSSSS",
        "SSSS",
        "SSS",
        "LLLL",
        "llll",
        "MMM",
        "ddd",
        "DDD",
        "LLL",
        "lll",
        "LTS",
        "YY",
        "GG",
        "gg",
        "Qo",
        "Mo",
        "MM",
        "Do",
        "DD",
        "do",
        "dd",
        "wo",
        "ww",
        "Wo",
        "WW",
        "HH",
        "hh",
        "kk",
        "mm",
        "ss",
        "SS",
        "ZZ",
        "zz",
        "LT",
        "LL",
        "ll",
        "Y",
        "Q",
        "M",
        "D",
        "d",
        "e",
        "E",
        "w",
        "W",
        "H",
        "h",
        "k",
        "m",
        "s",
        "S",
        "a",
        "A",
        "Z",
        "z",
        "X",
        "x",
        "L",
        "l",
    ];
    let mut output = String::new();
    let mut cursor = 0;
    while cursor < pattern.len() {
        let rest = &pattern[cursor..];
        if let Some(literal) = rest.strip_prefix('[') {
            if let Some(end) = literal.find(']') {
                output.push_str(&literal[..end]);
                cursor += end + 2;
                continue;
            }
        }
        if rest.starts_with('\\') {
            cursor += 1;
            if let Some(character) = pattern[cursor..].chars().next() {
                output.push(character);
                cursor += character.len_utf8();
            }
            continue;
        }
        if rest.starts_with('%') {
            return Err("unsupported\0Date formatting uses Moment tokens, not strftime".into());
        }
        let token = TOKENS
            .iter()
            .filter(|token| rest.starts_with(**token))
            .max_by_key(|token| token.len())
            .copied();
        let Some(token) = token else {
            let character = rest.chars().next().expect("nonempty");
            output.push(character);
            cursor += character.len_utf8();
            continue;
        };
        cursor += token.len();
        let text = match token {
            "Y" => date.year().to_string(),
            "YYYY" | "yyyy" => format!("{:04}", date.year()),
            "YYYYY" => format!("{:05}", date.year()),
            "YYYYYY" => format!("{:+07}", date.year()),
            "YY" => format!("{:02}", date.year().rem_euclid(100)),
            "Q" => ((month - 1) / 3 + 1).to_string(),
            "Qo" => ordinal((month - 1) / 3 + 1),
            "M" => month.to_string(),
            "MM" => format!("{month:02}"),
            "Mo" => ordinal(month),
            "MMM" => MONTHS[(month - 1) as usize][..3].into(),
            "MMMM" => MONTHS[(month - 1) as usize].into(),
            "D" => day.to_string(),
            "DD" => format!("{day:02}"),
            "Do" => ordinal(day),
            "DDD" => date.ordinal().to_string(),
            "DDDD" => format!("{:03}", date.ordinal()),
            "DDDo" => ordinal(date.ordinal()),
            "d" | "e" => weekday.to_string(),
            "E" => date.weekday().number_from_monday().to_string(),
            "do" => ordinal(weekday),
            "dd" => DAYS[weekday as usize][..2].into(),
            "ddd" => DAYS[weekday as usize][..3].into(),
            "dddd" => DAYS[weekday as usize].into(),
            "w" => week.to_string(),
            "ww" => format!("{week:02}"),
            "wo" => ordinal(week),
            "W" => iso_week.week().to_string(),
            "WW" => format!("{:02}", iso_week.week()),
            "Wo" => ordinal(iso_week.week()),
            "gg" => format!("{:02}", week_year.rem_euclid(100)),
            "gggg" => format!("{week_year:04}"),
            "GG" => format!("{:02}", iso_week.year().rem_euclid(100)),
            "GGGG" => format!("{:04}", iso_week.year()),
            "H" => date.hour().to_string(),
            "HH" => format!("{:02}", date.hour()),
            "h" => hour12(date.hour()).to_string(),
            "hh" => format!("{:02}", hour12(date.hour())),
            "k" => if date.hour() == 0 { 24 } else { date.hour() }.to_string(),
            "kk" => format!("{:02}", if date.hour() == 0 { 24 } else { date.hour() }),
            "m" => date.minute().to_string(),
            "mm" => format!("{:02}", date.minute()),
            "s" => date.second().to_string(),
            "ss" => format!("{:02}", date.second()),
            "S" => (date.and_utc().timestamp_subsec_millis() / 100).to_string(),
            "SS" => format!("{:02}", date.and_utc().timestamp_subsec_millis() / 10),
            "SSS" | "SSSS" | "SSSSS" | "SSSSSS" | "SSSSSSS" | "SSSSSSSS" | "SSSSSSSSS" => format!(
                "{:03}{}",
                date.and_utc().timestamp_subsec_millis(),
                "0".repeat(token.len() - 3)
            ),
            "a" => if date.hour() < 12 { "am" } else { "pm" }.into(),
            "A" => if date.hour() < 12 { "AM" } else { "PM" }.into(),
            "Z" | "ZZ" => format!(
                "{}{:02}{}{:02}",
                if offset < 0 { "-" } else { "+" },
                offset.abs() / 3600,
                if token == "Z" { ":" } else { "" },
                offset.abs() % 3600 / 60
            ),
            // Moment wraps a native Date, not a moment-timezone instance. Its
            // zone-abbreviation tokens have no named-zone value in this path.
            "z" | "zz" => String::new(),
            "X" => value.millis.div_euclid(1000).to_string(),
            "x" => value.millis.to_string(),
            "LT" => render(value, "h:mm A", depth + 1)?,
            "LTS" => render(value, "h:mm:ss A", depth + 1)?,
            "L" => render(value, "MM/DD/YYYY", depth + 1)?,
            "l" => render(value, "M/D/YYYY", depth + 1)?,
            "LL" => render(value, "MMMM D, YYYY", depth + 1)?,
            "ll" => render(value, "MMM D, YYYY", depth + 1)?,
            "LLL" => render(value, "MMMM D, YYYY h:mm A", depth + 1)?,
            "lll" => render(value, "MMM D, YYYY h:mm A", depth + 1)?,
            "LLLL" => render(value, "dddd, MMMM D, YYYY h:mm A", depth + 1)?,
            "llll" => render(value, "ddd, MMM D, YYYY h:mm A", depth + 1)?,
            _ => unreachable!("closed token vocabulary"),
        };
        output.push_str(&text);
        if output.len() > 1_048_576 {
            return Err("budget\0Formatted date exceeds byte budget".into());
        }
    }
    Ok(output)
}
fn hour12(hour: u32) -> u32 {
    match hour % 12 {
        0 => 12,
        hour => hour,
    }
}
fn ordinal(value: u32) -> String {
    format!(
        "{value}{}",
        if (11..=13).contains(&(value % 100)) {
            "th"
        } else {
            match value % 10 {
                1 => "st",
                2 => "nd",
                3 => "rd",
                _ => "th",
            }
        }
    )
}
fn sunday_week(date: NaiveDate) -> (i32, u32) {
    let year = date.year();
    let jan1 = NaiveDate::from_ymd_opt(year, 1, 1).expect("valid year");
    if let Some(next) = NaiveDate::from_ymd_opt(year + 1, 1, 1) {
        let start = next - Duration::days(i64::from(next.weekday().num_days_from_sunday()));
        if date >= start {
            return (year + 1, 1);
        }
    }
    (
        year,
        (date.ordinal0() + jan1.weekday().num_days_from_sunday()) / 7 + 1,
    )
}

#[cfg(test)]
mod tests {
    use super::super::{evaluate, BaseValue, BasesEvaluationContext};
    fn text(pattern: &str, timezone: &str) -> String {
        let context = BasesEvaluationContext {
            timezone: super::BasesTimezone::from_setting(Some(timezone)).unwrap(),
            ..Default::default()
        };
        let expression = format!(
            "date('2024-01-21T19:04:05.067Z').format({})",
            serde_json::to_string(pattern).unwrap()
        );
        let BaseValue::String { value } = evaluate(&expression, &context).unwrap().value else {
            panic!("text")
        };
        value
    }
    #[test]
    fn moment_calendar_tokens_literals_and_localized_english_formats() {
        assert_eq!(
            text("MMM D, YYYY [at] h:mm A", "UTC"),
            "Jan 21, 2024 at 7:04 PM"
        );
        assert_eq!(
            text("dddd, Do MMMM YYYY HH:mm:ss.SSS Z ZZ", "America/Toronto"),
            "Sunday, 21st January 2024 14:04:05.067 -05:00 -0500"
        );
        assert_eq!(
            text("YYYY [__L0__] [literal MM] [at] h:mm:ss a", "UTC"),
            "2024 __L0__ literal MM at 7:04:05 pm"
        );
        assert_eq!(text("LLL", "UTC"), "January 21, 2024 7:04 PM");
        assert_eq!(text("l", "UTC"), "1/21/2024");
        assert_eq!(
            text("Q Qo DDD DDDD w ww W WW d e E", "UTC"),
            "1 1st 21 021 4 04 3 03 0 0 7"
        );
        assert_eq!(text("S SS SSS SSSSSS", "UTC"), "0 06 067 067000");
    }
    #[test]
    fn offset_tokens_use_captured_timezone_and_patterns_are_bounded() {
        assert_eq!(text("Z ZZ", "+05:30"), "+05:30 +0530");
        assert_eq!(text("[Z] \\Z", "UTC"), "Z Z");
        assert_eq!(text("[100%]", "UTC"), "100%");
        assert_eq!(text("", "UTC"), "2024-01-21T19:04:05+00:00");
        let value = super::DateValue {
            millis: 0,
            date_only: false,
            timezone: super::BasesTimezone::Utc,
        };
        assert!(super::format(&value, &"Y".repeat(65_537))
            .unwrap_err()
            .starts_with("budget\0"));
        assert!(super::format(&value, "%z")
            .unwrap_err()
            .starts_with("unsupported\0"));
    }
}
