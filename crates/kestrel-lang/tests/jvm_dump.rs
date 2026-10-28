//! Scratch helper: prints the parse result of the file in `KESTREL_DUMP_FILE`.
use kestrel_lang::{parse, Lang};

#[test]
fn dump_file() {
    let Ok(path) = std::env::var("KESTREL_DUMP_FILE") else { return };
    let text = std::fs::read_to_string(&path).unwrap();
    let lang = Lang::from_extension(path.rsplit('.').next().unwrap()).unwrap();
    let m = parse(lang, &text);
    println!("package {:?}", m.package);
    for i in &m.imports {
        println!("import {} wc={} alias={:?} static={} L{}", i.path, i.wildcard, i.alias, i.is_static, i.line);
    }
    for (k, t) in m.types.iter().enumerate() {
        println!(
            "[{k}] {:?} {} outer={:?} mods={:?} annos={:?} tp={:?} L{}:{} {}-{}",
            t.kind, t.name, t.outer, t.modifiers, t.annotations, t.type_params, t.line, t.column, t.start_line, t.end_line
        );
        for s in &t.supertypes {
            println!("    super {:?} {} deleg={} args={}", s.kind, s.ty.text, s.delegated, s.ty.args.len());
        }
        if let Some(a) = &t.aliased {
            println!("    aliased {}", a.text);
        }
        for f in t.fields.iter().chain(t.methods.iter()) {
            println!(
                "    {:?} {} {:?} st={} abs={} mut={} ty={:?} recv={:?} params={:?} L{}:{}",
                f.kind, f.name, f.visibility, f.is_static, f.is_abstract, f.mutable,
                f.ty.as_ref().map(|t| &t.text), f.receiver.as_ref().map(|t| &t.text),
                f.params.iter().map(|p| format!("{}:{}", p.name, p.ty.as_ref().map(|t| t.text.as_str()).unwrap_or("?"))).collect::<Vec<_>>(),
                f.line, f.column
            );
        }
        println!("    used {:?}", t.used_types);
    }
    for f in &m.top_level {
        println!("  top {:?} {} {:?} ty={:?} recv={:?} params={}", f.kind, f.name, f.visibility, f.ty.as_ref().map(|t| &t.text), f.receiver.as_ref().map(|t| &t.text), f.params.len());
    }
}
