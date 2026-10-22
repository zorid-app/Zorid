//! Duration calendar semantics. The month interpolation is adapted from Moment
//! 2.30.1 (MIT), Copyright (c) JS Foundation and other contributors; see
//! ../LICENSE-MOMENT. Other behavior follows the recorded duration contract.
use super::{duration_finite, BasesTimezone, DateValue, DurationValue};
use chrono::{Datelike, Months, NaiveDate, NaiveDateTime, Timelike};
use regex::Regex;
use std::sync::LazyLock;

pub(super) fn parse(value: &str) -> Option<DurationValue> {
    static ISO: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"P(?:([.,0-9]+)Y)?(?:([.,0-9]+)M)?(?:([.,0-9]+)W)?(?:([.,0-9]+)D)?T(?:([.,0-9]+)H)?(?:([.,0-9]+)M)?(?:([.,0-9]+)S)?").unwrap()
    });
    static SIMPLE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(-?[0-9]+) ?([dhmswMy]|(?:second|minute|hour|day|week|month|year)s?)$")
            .unwrap()
    });
    if let Some(parts) = ISO.captures(value) {
        let part = |index| {
            parts.get(index).map_or(0.0, |part| {
                let digits = part.as_str().bytes().take_while(u8::is_ascii_digit).count();
                if digits == 0 {
                    f64::NAN
                } else {
                    part.as_str()[..digits].parse().unwrap_or(f64::INFINITY)
                }
            })
        };
        return Some(DurationValue {
            years: part(1),
            months: part(2),
            days: part(3) * 7.0 + part(4),
            hours: part(5),
            minutes: part(6),
            seconds: part(7),
            ..Default::default()
        });
    }
    let parts = SIMPLE.captures(value)?;
    let amount = parts[1].parse::<f64>().ok()?;
    let mut duration = DurationValue::default();
    match &parts[2] {
        "y" | "year" | "years" => duration.years = amount,
        "M" | "month" | "months" => duration.months = amount,
        "w" | "week" | "weeks" => duration.days = amount * 7.0,
        "d" | "day" | "days" => duration.days = amount,
        "h" | "hour" | "hours" => duration.hours = amount,
        "m" | "minute" | "minutes" => duration.minutes = amount,
        "s" | "second" | "seconds" => duration.seconds = amount,
        _ => return None,
    }
    Some(duration)
}
fn invalid() -> String {
    "numeric-domain\0Date arithmetic is out of range".into()
}
fn integer(value: f64) -> Result<i64, String> {
    if !value.is_finite() || value < i64::MIN as f64 || value >= i64::MAX as f64 {
        return Err(invalid());
    }
    Ok(value.trunc() as i64)
}
fn local_date(
    year: i64,
    month: u32,
    day: i64,
    time: chrono::NaiveTime,
) -> Result<NaiveDateTime, String> {
    NaiveDate::from_ymd_opt(i32::try_from(year).map_err(|_| invalid())?, month, 1)
        .and_then(|date| date.checked_add_signed(chrono::Duration::try_days(day.checked_sub(1)?)?))
        .map(|date| date.and_time(time))
        .ok_or_else(invalid)
}
fn resolved(zone: &BasesTimezone, local: NaiveDateTime) -> Result<i64, String> {
    // Keep the existing captured-timezone contract: a gap/fold is diagnostic,
    // rather than choosing an ambient platform-dependent disambiguation.
    zone.try_millis_from_local(local).ok_or_else(|| {
        "invalid-local-time\0Calendar arithmetic produced a nonunique local time".into()
    })
}

pub(super) fn add(
    value: &DateValue,
    duration: &DurationValue,
    direction: f64,
) -> Result<DateValue, String> {
    if !duration_finite(duration) || !direction.is_finite() {
        return Err(invalid());
    }
    let mut millis = value.millis;
    // JavaScript Date setters run in this order. Each setter truncates its own
    // complete field argument; combining years/months or elapsed time changes
    // leap-day overflow, fractional units and daylight-saving behavior.
    let amounts = [
        duration.years,
        duration.months,
        duration.days + duration.weeks * 7.0,
        duration.hours,
        duration.minutes,
        duration.seconds,
        duration.milliseconds,
    ];
    for (field, amount) in amounts.into_iter().enumerate() {
        if amount == 0.0 {
            continue;
        }
        let date = value.timezone.local_datetime(millis);
        let amount = amount * direction;
        let next = match field {
            0 => local_date(
                integer(date.year() as f64 + amount)?,
                date.month(),
                date.day() as i64,
                date.time(),
            )?,
            1 => {
                let month = integer(date.month0() as f64 + amount)?;
                let total = (date.year() as i64)
                    .checked_mul(12)
                    .and_then(|year| year.checked_add(month))
                    .ok_or_else(invalid)?;
                local_date(
                    total.div_euclid(12),
                    total.rem_euclid(12) as u32 + 1,
                    date.day() as i64,
                    date.time(),
                )?
            }
            2 => local_date(
                date.year() as i64,
                date.month(),
                integer(date.day() as f64 + amount)?,
                date.time(),
            )?,
            _ => {
                let (hours, minutes, seconds, milliseconds) = (
                    date.hour(),
                    date.minute(),
                    date.second(),
                    date.nanosecond() / 1_000_000,
                );
                let (base, delta) = match field {
                    3 => (
                        date.date()
                            .and_hms_milli_opt(0, minutes, seconds, milliseconds),
                        chrono::Duration::try_hours(integer(hours as f64 + amount)?),
                    ),
                    4 => (
                        date.date()
                            .and_hms_milli_opt(hours, 0, seconds, milliseconds),
                        chrono::Duration::try_minutes(integer(minutes as f64 + amount)?),
                    ),
                    5 => (
                        date.date()
                            .and_hms_milli_opt(hours, minutes, 0, milliseconds),
                        chrono::Duration::try_seconds(integer(seconds as f64 + amount)?),
                    ),
                    _ => (
                        date.date().and_hms_milli_opt(hours, minutes, seconds, 0),
                        chrono::Duration::try_milliseconds(integer(milliseconds as f64 + amount)?),
                    ),
                };
                base.and_then(|base| base.checked_add_signed(delta?))
                    .ok_or_else(invalid)?
            }
        };
        millis = resolved(&value.timezone, next)?;
    }
    Ok(DateValue {
        millis,
        date_only: value.date_only
            && [
                duration.hours,
                duration.minutes,
                duration.seconds,
                duration.milliseconds,
            ]
            .iter()
            .all(|part| *part == 0.0),
        timezone: value.timezone.clone(),
    })
}

pub(super) fn elapsed(value: &DurationValue, anchor: &DateValue) -> Result<f64, String> {
    Ok(add(anchor, value, 1.0)?.millis as f64 - anchor.millis as f64)
}
fn clamped_month_shift(value: &DateValue, months: i64) -> Result<DateValue, String> {
    let local = value.timezone.local_datetime(value.millis);
    let amount = u32::try_from(months.unsigned_abs()).map_err(|_| invalid())?;
    let shifted = if months < 0 {
        local.checked_sub_months(Months::new(amount))
    } else {
        local.checked_add_months(Months::new(amount))
    }
    .ok_or_else(invalid)?;
    Ok(DateValue {
        millis: resolved(&value.timezone, shifted)?,
        ..value.clone()
    })
}
// Moment's fractional month difference intentionally uses clamped anchors.
// This is distinct from the overflowing Date setters used by duration addition.
fn month_difference(left: &DateValue, right: &DateValue) -> Result<f64, String> {
    let a = left.timezone.local_datetime(left.millis);
    let b = right.timezone.local_datetime(right.millis);
    if a.day() < b.day() {
        return Ok(-month_difference(right, left)?);
    }
    let whole = (b.year() as i64 - a.year() as i64) * 12 + b.month0() as i64 - a.month0() as i64;
    let anchor = clamped_month_shift(left, whole)?;
    let difference = right.millis as f64 - anchor.millis as f64;
    let denominator = if difference < 0.0 {
        anchor.millis as f64 - clamped_month_shift(left, whole - 1)?.millis as f64
    } else {
        clamped_month_shift(left, whole + 1)?.millis as f64 - anchor.millis as f64
    };
    let result = -(whole as f64 + difference / denominator);
    if !result.is_finite() {
        return Err(invalid());
    }
    Ok(if result == 0.0 { 0.0 } else { result })
}
pub(super) fn property(
    value: &DurationValue,
    name: &str,
    anchor: &DateValue,
) -> Result<f64, String> {
    let end = add(anchor, value, 1.0)?;
    let elapsed = end.millis as f64 - anchor.millis as f64;
    let civil = || {
        end.timezone
            .local_datetime(end.millis)
            .signed_duration_since(anchor.timezone.local_datetime(anchor.millis))
            .num_milliseconds() as f64
    };
    match name {
        "years" => Ok(month_difference(&end, anchor)? / 12.0),
        "months" => month_difference(&end, anchor),
        "weeks" => Ok(civil() / 604_800_000.0),
        "days" => Ok(civil() / 86_400_000.0),
        "hours" => Ok(elapsed / 3_600_000.0),
        "minutes" => Ok(elapsed / 60_000.0),
        "seconds" => Ok(elapsed / 1000.0),
        "milliseconds" => Ok(elapsed),
        _ => Err(format!("access\0Unknown Duration property {name}")),
    }
}
