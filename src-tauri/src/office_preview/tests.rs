use super::*;

fn fixture(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/preview-fixtures")
        .join(name)
}

#[test]
fn workbook_retains_names_sparse_addresses_dates_and_uncalculated_formulas() {
    let (preview, truncated) = read(&fixture("workbook.xlsx"), "xlsx").unwrap();
    assert!(!truncated);
    let StructuredPreview::Spreadsheet { sheets } = preview else {
        panic!("expected workbook")
    };
    assert_eq!(sheets[0].name, "销售明细");
    assert_eq!(sheets[1].name, "客户备注");
    assert_eq!(sheets[0].rows[1][3].value, "75");
    assert_eq!(sheets[0].rows[1][3].formula.as_deref(), Some("B2*C2"));
    assert_eq!(sheets[0].rows[3][3].formula.as_deref(), Some("SUM(D2:D3)"));
    assert!(sheets[0].rows[3][3].value.is_empty());
    assert!(sheets[0].rows[5][1].value.starts_with("2026-09-08"));
    assert_eq!((sheets[1].row_offset, sheets[1].column_offset), (2, 2));
    assert_eq!(sheets[1].rows[0][0].value, "空白行列应保留");
    assert!(sheets[1].rows[0][1].value.is_empty());
    assert_eq!(sheets[1].rows[0][2].value, "多行\n备注");
}

#[test]
fn csv_handles_bom_quoted_delimiters_multiline_values_and_empty_cells() {
    let (preview, truncated) = read(&fixture("quoted.csv"), "csv").unwrap();
    assert!(!truncated);
    let StructuredPreview::Spreadsheet { sheets } = preview else {
        panic!("expected workbook")
    };
    assert_eq!(sheets[0].rows[0][0].value, "名称");
    assert_eq!(sheets[0].rows[1][0].value, "项目,一");
    assert_eq!(sheets[0].rows[1][1].value, "第一行\n第二行");
    assert!(sheets[0].rows[2][1].value.is_empty());
    assert_eq!(sheets[0].rows[2][2].value, "0");
}

#[test]
fn csv_preserves_crlf_inside_quoted_values() {
    let source = std::fs::read_to_string(fixture("quoted.csv")).unwrap();
    let path = std::env::temp_dir().join(format!("xiaoyin-preview-{}.csv", uuid::Uuid::new_v4()));
    std::fs::write(&path, source.replace("\r\n", "\n").replace('\n', "\r\n")).unwrap();
    let result = read(&path, "csv");
    std::fs::remove_file(path).unwrap();
    let (StructuredPreview::Spreadsheet { sheets }, truncated) = result.unwrap() else {
        panic!("expected workbook")
    };
    assert!(!truncated);
    assert_eq!(sheets[0].rows[1][1].value, "第一行\r\n第二行");
    assert_eq!(sheets[0].rows[2][2].value, "0");
}

#[test]
fn document_preserves_headings_and_table_cells() {
    let (preview, truncated) = read(&fixture("brief.docx"), "docx").unwrap();
    assert!(!truncated);
    let StructuredPreview::Document { blocks } = preview else {
        panic!("expected document")
    };
    assert!(
        matches!(&blocks[0], PreviewBlock::Paragraph { text, level: 1 } if text == "季度经营简报")
    );
    assert!(blocks.iter().any(
        |block| matches!(block, PreviewBlock::Table { rows } if rows[1][1] == "完成需求评审")
    ));
}

#[test]
fn presentation_follows_manifest_order_instead_of_slide_filenames() {
    use std::io::Write;
    let mut source = archive(&fixture("plan.pptx")).unwrap();
    let manifest = read_xml(&mut source, "ppt/presentation.xml").unwrap();
    let document = parse_xml(&manifest).unwrap();
    let list = document
        .descendants()
        .find(|node| node.has_tag_name("sldIdLst"))
        .unwrap();
    let ids = list
        .children()
        .filter(|node| node.has_tag_name("sldId"))
        .collect::<Vec<_>>();
    let reversed = ids
        .iter()
        .rev()
        .map(|node| &manifest[node.range()])
        .collect::<String>();
    let mut modified = manifest.clone();
    modified.replace_range(
        ids.first().unwrap().range().start..ids.last().unwrap().range().end,
        &reversed,
    );
    let path = std::env::temp_dir().join(format!("xiaoyin-preview-{}.pptx", uuid::Uuid::new_v4()));
    let mut output = zip::ZipWriter::new(File::create(&path).unwrap());
    for index in 0..source.len() {
        let mut entry = source.by_index(index).unwrap();
        output
            .start_file(entry.name(), zip::write::SimpleFileOptions::default())
            .unwrap();
        if entry.name() == "ppt/presentation.xml" {
            output.write_all(modified.as_bytes()).unwrap();
        } else {
            std::io::copy(&mut entry, &mut output).unwrap();
        }
    }
    output.finish().unwrap();
    let result = read(&path, "pptx");
    std::fs::remove_file(path).unwrap();
    let (StructuredPreview::Presentation { slides }, _) = result.unwrap() else {
        panic!("expected presentation")
    };
    assert!(matches!(&slides[0][0], PreviewBlock::Paragraph { text, .. } if text == "交付检查"));
    assert!(matches!(&slides[2][0], PreviewBlock::Paragraph { text, .. } if text == "业务目标"));
}

#[test]
fn malformed_xml_and_excessive_sparse_dimensions_are_rejected() {
    assert!(parse_xml("<document><p>broken").is_err());
    assert!(validate_sheet_dimensions(&parse_xml("<worksheet><c r=\"A1\"><f t=\"shared\" si=\"4294967295\" ref=\"A1\">1</f></c></worksheet>").unwrap()).is_err());
    for reference in ["XFD1048576", "A0", "999"] {
        let xml = format!("<worksheet><c r=\"{reference}\"/></worksheet>");
        assert!(validate_sheet_dimensions(&parse_xml(&xml).unwrap()).is_err());
    }
    let xml = "<worksheet><c r=\"C3\"/><c r=\"E3\"/></worksheet>";
    assert!(validate_sheet_dimensions(&parse_xml(xml).unwrap()).is_ok());
}

#[test]
fn text_and_row_limits_are_reported_as_partial_content() {
    let mut budget = Budget::default();
    assert_eq!(budget.text("x".repeat(MAX_TEXT + 1)).len(), MAX_TEXT);
    assert!(budget.truncated);
    let path = std::env::temp_dir().join(format!("xiaoyin-preview-{}.csv", uuid::Uuid::new_v4()));
    std::fs::write(&path, "value\n".repeat(MAX_ROWS + 1)).unwrap();
    let result = read(&path, "csv");
    std::fs::remove_file(path).unwrap();
    let (StructuredPreview::Spreadsheet { sheets }, truncated) = result.unwrap() else {
        panic!("expected workbook")
    };
    assert_eq!(sheets[0].rows.len(), MAX_ROWS);
    assert!(truncated && sheets[0].truncated);
}
