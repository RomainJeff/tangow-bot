# Office toolchain available on this computer

Everything below runs from the `shell` tool. Open a document in LibreOffice with `launch_app`
only when someone needs to see it on screen.

## Read
- PDF text: `pdftotext -layout file.pdf -` ; page images: `pdftoppm -png -r 80 file.pdf out`
- PDF in Python: `pdfplumber`, `pypdf`, `pymupdf` (`import pymupdf`)
- DOCX/XLSX/PPTX text: `pandoc file.docx -t markdown` ; Python: `python-docx`, `openpyxl`, `python-pptx`

## Write
- DOCX: `python-docx`, Node `docx`, or `pandoc notes.md -o out.docx`
- PPTX: `python-pptx` or Node `pptxgenjs` (`node -e "const p=require('pptxgenjs')..."`)
- XLSX: `openpyxl` or `xlsxwriter`
- PDF: `reportlab`, or convert any office file (see below)

## Convert / render (LibreOffice headless)
- Any office file to PDF: `soffice --headless --convert-to pdf --outdir out/ file.docx`
- DOCX <-> ODT, XLSX <-> CSV, PPTX -> PDF: same command with the target extension
- Visual check of a deck: convert to PDF, then `pdftoppm -png -r 60 out/file.pdf preview`

## Notes
- Fonts: Carlito (Calibri-compatible), Caladea (Cambria-compatible), Liberation, DejaVu, Noto.
- Python packages are system-wide; extra ones: `pip3 install --user <pkg>` (persists in $HOME).
- Node globals live in $NODE_PATH; extra ones: `npm install <pkg>` inside your workspace.
