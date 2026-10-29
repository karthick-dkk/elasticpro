//! A spreadsheet, written by the core (the approach of `ui/js/lib/xlsx.js`, ported).
//!
//! An .xlsx is a ZIP of XML parts. What a report needs is a fraction of the format: a
//! workbook, a few sheets, inline strings, numbers that stay numbers so a column can be
//! summed, and a styles part with a bold header and two number formats. No shared-strings
//! table (it deduplicates text across large books; these are a few thousand rows), no
//! formulas — a cell is a value the core measured or derived, never something Excel works
//! out again.
//!
//! The styles use only built-in number formats (3 = `#,##0`, 4 = `#,##0.00`), so there is
//! no `numFmts` block to get wrong.

use super::zip::{self, Entry};

/// One cell. `Empty` is an empty cell; a value that was not measured is written as the
/// text "not measured" by the builder, never as an empty cell or a 0.
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Empty,
    Text(String),
    /// A bold text cell: column headers and block titles.
    Head(String),
    /// A whole number, shown with thousands separators.
    Int(f64),
    /// A number shown with two decimals (GB, percentages).
    Dec(f64),
}

impl Cell {
    pub fn text(s: impl Into<String>) -> Cell {
        Cell::Text(s.into())
    }
    pub fn head(s: impl Into<String>) -> Cell {
        Cell::Head(s.into())
    }
}

pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<Cell>>,
}

/// Style indices in `styles.xml` `cellXfs`.
const S_HEAD: u8 = 1;
const S_INT: u8 = 2;
const S_DEC: u8 = 3;

pub const MIME: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// XML text escaping. Cell values are index names, field values and error strings that came
/// from a cluster: one with `&` or `<` must not be able to end the cell it is in. Characters
/// XML 1.0 forbids outright are dropped, because there is no escape for them.
pub fn xml_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{fffe}' || c == '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

/// A1, B1 … Z1, AA1.
pub fn cell_ref(col: usize, row: usize) -> String {
    let mut s = Vec::new();
    let mut n = col as i64;
    loop {
        s.push((b'A' + (n % 26) as u8) as char);
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    s.iter().rev().collect::<String>() + &(row + 1).to_string()
}

/// Excel refuses a sheet name over 31 characters or containing `: \ / ? * [ ]`, and one
/// that starts or ends with an apostrophe.
pub fn safe_sheet_name(name: &str, fallback: &str) -> String {
    let clean: String = name.chars().map(|c| if ":\\/?*[]".contains(c) || c.is_control() { ' ' } else { c }).collect();
    let clean: String = clean.trim().trim_matches('\'').trim().chars().take(31).collect();
    let clean = clean.trim_end().to_string();
    if clean.is_empty() { fallback.to_string() } else { clean }
}

/// Every sheet a name of its own: Excel will not open a book with two sheets of the same
/// name (case-insensitively), and cutting names to 31 characters is a good way to make two.
pub fn unique_names(names: &[String]) -> Vec<String> {
    let mut used: Vec<String> = vec![];
    let mut out = vec![];
    for (i, n) in names.iter().enumerate() {
        let base = safe_sheet_name(n, &format!("Sheet{}", i + 1));
        let mut name = base.clone();
        let mut k = 2;
        while used.contains(&name.to_lowercase()) {
            let suffix = format!(" {k}");
            let keep = 31 - suffix.chars().count();
            name = format!("{}{suffix}", base.chars().take(keep).collect::<String>().trim_end());
            k += 1;
        }
        used.push(name.to_lowercase());
        out.push(name);
    }
    out
}

fn num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 { format!("{}", v as i64) } else { format!("{v}") }
}

fn cell_xml(c: &Cell, col: usize, row: usize) -> String {
    let r = cell_ref(col, row);
    match c {
        Cell::Empty => String::new(),
        Cell::Int(v) | Cell::Dec(v) if !v.is_finite() => String::new(),
        Cell::Int(v) => format!(r#"<c r="{r}" s="{S_INT}"><v>{}</v></c>"#, num(*v)),
        Cell::Dec(v) => format!(r#"<c r="{r}" s="{S_DEC}"><v>{}</v></c>"#, num(*v)),
        Cell::Text(s) => format!(r#"<c r="{r}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#, xml_text(s)),
        Cell::Head(s) => format!(r#"<c r="{r}" s="{S_HEAD}" t="inlineStr"><is><t xml:space="preserve">{}</t></is></c>"#, xml_text(s)),
    }
}

/// Column widths from the longest value in each, so the file opens readable.
fn cols_xml(rows: &[Vec<Cell>]) -> String {
    let n = rows.iter().map(Vec::len).max().unwrap_or(0);
    if n == 0 {
        return String::new();
    }
    let mut w = vec![8usize; n];
    for row in rows {
        for (i, c) in row.iter().enumerate() {
            let len = match c {
                Cell::Text(s) | Cell::Head(s) => s.chars().count() + 2,
                Cell::Int(v) | Cell::Dec(v) => num(*v).len() + 4,
                Cell::Empty => 0,
            };
            w[i] = w[i].max(len.min(60));
        }
    }
    let cols: String = w.iter().enumerate()
        .map(|(i, w)| format!(r#"<col min="{0}" max="{0}" width="{w}" customWidth="1"/>"#, i + 1)).collect();
    format!("<cols>{cols}</cols>")
}

fn sheet_xml(rows: &[Vec<Cell>]) -> String {
    let mut body = String::new();
    for (r, cells) in rows.iter().enumerate() {
        body.push_str(&format!(r#"<row r="{}">"#, r + 1));
        for (c, cell) in cells.iter().enumerate() {
            body.push_str(&cell_xml(cell, c, r));
        }
        body.push_str("</row>");
    }
    // The header row stays in view while scrolling a year of days.
    let pane = r#"<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>"#;
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">{pane}{}<sheetData>{body}</sheetData></worksheet>"#,
        cols_xml(rows)
    )
}

const STYLES: &str = concat!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
    r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
    r#"<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>"#,
    r#"<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>"#,
    r#"<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>"#,
    r#"<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>"#,
    r#"<cellXfs count="4">"#,
    r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>"#,
    r#"<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>"#,
    r#"<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>"#,
    r#"<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>"#,
    r#"</cellXfs>"#,
    r#"<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>"#,
    r#"</styleSheet>"#,
);

/// The bytes of an .xlsx with these sheets (names made safe and unique).
pub fn workbook(sheets: &[Sheet]) -> Result<Vec<u8>, String> {
    let names = unique_names(&sheets.iter().map(|s| s.name.clone()).collect::<Vec<_>>());
    let head = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;
    let overrides: String = (1..=sheets.len()).map(|i| format!(
        r#"<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#
    )).collect();
    let content_types = format!(
        r#"{head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>{overrides}</Types>"#
    );
    let rels = format!(
        r#"{head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#
    );
    let sheet_list: String = names.iter().enumerate()
        .map(|(i, n)| format!(r#"<sheet name="{}" sheetId="{}" r:id="rId{}"/>"#, xml_text(n), i + 1, i + 1)).collect();
    let workbook = format!(
        r#"{head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{sheet_list}</sheets></workbook>"#
    );
    let mut wb_rels: String = (1..=sheets.len()).map(|i| format!(
        r#"<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>"#
    )).collect();
    wb_rels.push_str(&format!(
        r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#,
        sheets.len() + 1
    ));
    let wb_rels = format!(r#"{head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{wb_rels}</Relationships>"#);
    let mut entries = vec![
        Entry::new("[Content_Types].xml", content_types),
        Entry::new("_rels/.rels", rels),
        Entry::new("xl/workbook.xml", workbook),
        Entry::new("xl/_rels/workbook.xml.rels", wb_rels),
        Entry::new("xl/styles.xml", STYLES),
    ];
    for (i, s) in sheets.iter().enumerate() {
        entries.push(Entry::new(format!("xl/worksheets/sheet{}.xml", i + 1), sheet_xml(&s.rows)));
    }
    zip::write(&entries)
}

/// A minimal well-formedness check for the tests: every tag closes in order, attribute
/// values are quoted, and text holds no raw `<` and no `&` that is not an entity.
#[cfg(test)]
pub fn well_formed(xml: &str) -> Result<(), String> {
    let body = xml.strip_prefix(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#).ok_or("no declaration")?;
    let mut stack: Vec<String> = vec![];
    let mut rest = body;
    let entity_ok = |t: &str| -> bool {
        let mut s = t;
        while let Some(i) = s.find('&') {
            let tail = &s[i..];
            if !["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"].iter().any(|e| tail.starts_with(e)) {
                return false;
            }
            s = &tail[1..];
        }
        true
    };
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            return if entity_ok(rest) && stack.is_empty() { Ok(()) } else { Err("trailing text".into()) };
        };
        if !entity_ok(&rest[..lt]) || rest[..lt].contains('>') {
            return Err(format!("bad text before {:?}", &rest[lt..rest.len().min(lt + 40)]));
        }
        let gt = rest[lt..].find('>').ok_or("unclosed tag")? + lt;
        let tag = &rest[lt + 1..gt];
        if tag.contains('<') {
            return Err(format!("< inside a tag: {tag}"));
        }
        if tag.matches('"').count() % 2 != 0 || !entity_ok(tag) {
            return Err(format!("bad attributes: {tag}"));
        }
        if let Some(name) = tag.strip_prefix('/') {
            if stack.pop().as_deref() != Some(name.trim()) {
                return Err(format!("</{name}> closes the wrong element"));
            }
        } else if !tag.ends_with('/') {
            stack.push(tag.split_whitespace().next().unwrap_or("").to_string());
        }
        rest = &rest[gt + 1..];
    }
    if stack.is_empty() { Ok(()) } else { Err(format!("unclosed: {stack:?}")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_names_and_escaping() {
        assert_eq!(cell_ref(0, 0), "A1");
        assert_eq!(cell_ref(25, 9), "Z10");
        assert_eq!(cell_ref(26, 0), "AA1");
        assert_eq!(cell_ref(27, 0), "AB1");
        assert_eq!(cell_ref(701, 0), "ZZ1");
        assert_eq!(cell_ref(702, 0), "AAA1");
        assert_eq!(xml_text("a<b>&\"c\"\u{1}d\te"), "a&lt;b&gt;&amp;&quot;c&quot;d\te");
        assert_eq!(safe_sheet_name("a/b:c?[d]*", "S"), "a b c  d");
        assert_eq!(safe_sheet_name("  ", "S"), "S");
        assert_eq!(safe_sheet_name(&"x".repeat(40), "S").len(), 31);
        let names = unique_names(&[format!("{} Daily", "c".repeat(30)), format!("{} Daily", "c".repeat(30)), "daily".into(), "Daily".into()]);
        assert!(names.iter().all(|n| n.chars().count() <= 31), "{names:?}");
        let lower: std::collections::HashSet<String> = names.iter().map(|n| n.to_lowercase()).collect();
        assert_eq!(lower.len(), 4, "unique ignoring case: {names:?}");
    }

    #[test]
    fn a_workbook_opens_and_every_part_is_well_formed() {
        let rows = vec![
            vec![Cell::head("Day"), Cell::head("Primary (bytes)"), Cell::head("Primary GB"), Cell::head("Docs")],
            vec![Cell::text("2026-10-20"), Cell::Int(1_073_741_824.0), Cell::Dec(1.0), Cell::text("not measured")],
            vec![Cell::text("<script>&amp"), Cell::Empty, Cell::Dec(f64::NAN), Cell::Int(3.0)],
        ];
        let bytes = workbook(&[Sheet { name: "Daily".into(), rows }, Sheet { name: "Daily".into(), rows: vec![] }]).unwrap();
        let parts = zip::read(&bytes).unwrap();
        let names: Vec<&str> = parts.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
                           "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]);
        for (n, data) in &parts {
            let text = std::str::from_utf8(data).unwrap();
            well_formed(text).unwrap_or_else(|e| panic!("{n}: {e}\n{text}"));
        }
        let sheet = std::str::from_utf8(&parts[5].1).unwrap();
        assert!(sheet.contains(r#"<c r="B2" s="2"><v>1073741824</v></c>"#), "{sheet}");
        assert!(sheet.contains(r#"<c r="C2" s="3"><v>1</v></c>"#));
        assert!(sheet.contains("&lt;script&gt;&amp;amp"), "text is escaped: {sheet}");
        assert!(sheet.contains(r#"<c r="A1" s="1" t="inlineStr">"#), "the header is bold");
        assert!(!sheet.contains(r#"r="B3""#) && !sheet.contains(r#"r="C3""#), "empty and NaN cells are left out");
        let wb = std::str::from_utf8(&parts[2].1).unwrap();
        assert!(wb.contains(r#"name="Daily""#) && wb.contains(r#"name="Daily 2""#), "{wb}");
        let rels = std::str::from_utf8(&parts[3].1).unwrap();
        assert!(rels.contains("styles.xml"));
        assert!(well_formed("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><a><b></a></b>").is_err());
        assert!(well_formed("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><a>x & y</a>").is_err());
    }
}
