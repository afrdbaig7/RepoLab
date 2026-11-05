"""Isolated, deterministic-layout learning PDF generation and page previews."""
from pathlib import Path
import json
import re
import textwrap
import subprocess
from xml.sax.saxutils import escape

import fitz
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, PageBreak,
    Preformatted, KeepTogether, Flowable, TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output/pdf"
PREVIEWS = ROOT / "tmp/pdfs"
OUT.mkdir(parents=True, exist_ok=True)
PREVIEWS.mkdir(parents=True, exist_ok=True)
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="Body", fontName="Helvetica", fontSize=10,
                          leading=15, spaceAfter=8, alignment=TA_LEFT,
                          textColor=colors.HexColor("#253247")))
styles.add(ParagraphStyle(name="CodeSmall", fontName="Courier", fontSize=8.3,
                          leading=11.5, spaceAfter=8, backColor=colors.HexColor("#f1f5f9"),
                          leftIndent=6, rightIndent=6))
styles["Heading1"].fontSize = 21
styles["Heading1"].leading = 26
styles["Heading2"].fontSize = 15
styles["Heading2"].leading = 20
styles["Heading3"].fontSize = 11
styles["Heading3"].leading = 15
for name in ["Heading1", "Heading2", "Heading3"]:
    styles[name].keepWithNext = True


class Diagram(Flowable):
    def __init__(self):
        super().__init__()
        self.width, self.height = 165 * mm, 44 * mm

    def draw(self):
        canvas = self.canv
        labels = [["CLI / Action", "Rust + Git", "Blob manifest"],
                  ["Isolated AST", "Rules + evidence", "Four report views"]]
        for row, names in enumerate(labels):
            for column, label in enumerate(names):
                x, y = column * 55 * mm, (1 - row) * 23 * mm
                canvas.setFillColor(colors.HexColor("#e8f0fc"))
                canvas.setStrokeColor(colors.HexColor("#7894bd"))
                canvas.roundRect(x, y, 49 * mm, 16 * mm, 4, fill=1)
                canvas.setFillColor(colors.HexColor("#17345c"))
                canvas.setFont("Helvetica-Bold", 9)
                canvas.drawCentredString(x + 24.5 * mm, y + 6 * mm, label)
                if column < 2:
                    canvas.line(x + 49 * mm, y + 8 * mm, x + 54 * mm, y + 8 * mm)
        canvas.setStrokeColor(colors.HexColor("#7894bd"))
        path = canvas.beginPath()
        path.moveTo(134.5 * mm, 23 * mm)
        path.lineTo(134.5 * mm, 19.5 * mm)
        path.lineTo(24.5 * mm, 19.5 * mm)
        path.lineTo(24.5 * mm, 16 * mm)
        canvas.drawPath(path)


class Book(BaseDocTemplate):
    def __init__(self, path, title):
        super().__init__(str(path), pagesize=(210 * mm, 297 * mm),
                         leftMargin=20 * mm, rightMargin=20 * mm,
                         topMargin=20 * mm, bottomMargin=20 * mm,
                         title=title, author="Lens workspace contributors")
        self.book_title = title
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height,
                      leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates(PageTemplate(id="main", frames=frame, onPage=self.footer))

    def footer(self, canvas, document):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#64748b"))
        canvas.drawString(20 * mm, 11 * mm, self.book_title)
        canvas.drawRightString(190 * mm, 11 * mm, str(document.page))
        canvas.restoreState()

    def afterFlowable(self, flowable):
        levels = ["Heading1", "Heading2"] if "source walkthrough" in self.book_title else ["Heading1"]
        if isinstance(flowable, Paragraph) and flowable.style.name in levels:
            self.notify("TOCEntry", (0 if flowable.style.name == "Heading1" else 1,
                                     flowable.getPlainText(), self.page))


def inline(text):
    # Plain, readable labels; avoid unresolved Markdown tokens in PDF body text.
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1 (\2)", text)
    return escape(text).replace("`", "")


def markdown(text):
    result, paragraph, code = [], [], []
    in_code = False

    def flush():
        if paragraph:
            result.append(Paragraph(inline(" ".join(paragraph)), styles["Body"]))
            paragraph.clear()

    for line in text.splitlines():
        if line.startswith("```"):
            flush()
            if in_code:
                wrapped = []
                for source_line in code:
                    printable = "".join(character if ord(character) < 128 else f"\\u{ord(character):04x}" for character in source_line)
                    wrapped.extend(textwrap.wrap(printable.expandtabs(4), width=92,
                                                  replace_whitespace=False,
                                                  drop_whitespace=False) or [""])
                # Small independent blocks permit clean page breaks in long source.
                if result and isinstance(result[-1], Paragraph):
                    result[-1].keepWithNext = True
                result.append(Preformatted("\n".join(wrapped[:8]), styles["CodeSmall"]))
                for start in range(8, len(wrapped), 28):
                    result.append(Preformatted("\n".join(wrapped[start:start + 28]), styles["CodeSmall"]))
                code.clear()
            in_code = not in_code
        elif in_code:
            code.append(line)
        elif line.startswith("#"):
            flush()
            level = min(3, len(line) - len(line.lstrip("#")))
            result.append(Paragraph(inline(line.lstrip("# ")), styles[f"Heading{level}"]))
        elif not line.strip():
            flush()
        elif line.startswith("| "):
            flush()
            if not line.startswith("| ---"):
                cells = [cell.strip() for cell in line.strip("|").split("|")]
                result.append(Paragraph(inline(" / ".join(cells)), styles["Body"]))
        elif re.match(r"^(?:- |\d+\. )", line):
            flush()
            result.append(Paragraph(inline(line), styles["Body"]))
        else:
            paragraph.append(line.strip())
    flush()
    return result


def build(name, title, sources, diagram=False):
    coverage = json.loads((ROOT / "docs/learning/annotation-coverage.json").read_text())
    try:
        revision = subprocess.run(["git", "rev-parse", "--verify", "HEAD"], cwd=ROOT,
                                  capture_output=True, text=True, timeout=5, check=True).stdout.strip()
        status = subprocess.run(["git", "-c", "core.fsmonitor=false", "status", "--porcelain"],
                                cwd=ROOT, capture_output=True, text=True, timeout=5, check=True).stdout
        context = f"Git revision: {revision}. Worktree: {'dirty' if status else 'clean'}."
    except (OSError, subprocess.SubprocessError):
        context = "Git revision/dirty state unavailable; source digest is the snapshot anchor."
    story = [Paragraph(title, styles["Title"]), Spacer(1, 8 * mm),
             Paragraph("Implemented software, evidence and honest limits", styles["Heading2"]),
             Paragraph("Source snapshot: " + coverage["sourceDigest"], styles["Body"]),
             Paragraph(inline(context), styles["Body"]),
             Paragraph("Local Windows verification; hosted CI and broader release gates remain open.", styles["Body"]),
             PageBreak(), Paragraph("Contents", styles["Title"])]
    toc = TableOfContents()
    toc.levelStyles = [ParagraphStyle(name="TOC0", fontName="Helvetica-Bold", fontSize=10, leading=15, spaceBefore=6),
                       ParagraphStyle(name="TOC1", fontName="Helvetica", fontSize=9, leading=13, leftIndent=12)]
    toc.tableStyle = TableStyle([("TOPPADDING", (0, 0), (-1, -1), 0),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                                ("VALIGN", (0, 0), (-1, -1), "TOP")])
    story.extend([toc, PageBreak()])
    if diagram:
        story.extend([Paragraph("Implemented execution map", styles["Heading1"]),
                      Diagram(), Spacer(1, 6 * mm)])
    for index, source in enumerate(sources):
        if index:
            story.append(PageBreak())
        story.extend(markdown((ROOT / source).read_text(encoding="utf-8")))
    path = OUT / name
    Book(path, title).multiBuild(story)
    pdf = fitz.open(path)
    selected = sorted({0, min(2, len(pdf) - 1), len(pdf) // 2, len(pdf) - 1})
    for number in selected:
        pdf[number].get_pixmap(matrix=fitz.Matrix(1.2, 1.2)).save(PREVIEWS / f"{path.stem}-{number + 1}.png")
    print(json.dumps({"file": str(path), "pages": len(pdf), "previewPages": [number + 1 for number in selected]}))


build("lens-overview.pdf", "Lens implementation learning guide", [
    "docs/learning/guide.md", "docs/learning/chapters/01-fixtures.md",
    "docs/learning/chapters/02-worker.md", "docs/learning/chapters/03-reports-and-delivery.md",
    "docs/learning/chapters/04-projects-and-provenance.md",
    "docs/learning/concept-index.md", "docs/learning/file-map.md"], diagram=True)
build("lens-source-volume-1.pdf", "Lens source walkthrough - volume 1", [
    "docs/learning/chapters/source-walkthrough.md"])
