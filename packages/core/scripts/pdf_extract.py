"""PyMuPDF PDF worker：一次打开文档后批量提取文本或渲染指定页。"""
import argparse
import json
import os
import sys


def load_fitz():
    """延迟加载 PyMuPDF，使 check 子命令能返回稳定依赖诊断。"""
    import fitz
    return fitz


def check_runtime(_args):
    """验证 PyMuPDF 可导入。"""
    fitz = load_fitz()
    print(json.dumps({"version": fitz.VersionBind}))


def extract_text(args):
    """一次打开 PDF 并提取所有页文本。"""
    fitz = load_fitz()
    try:
        document = fitz.open(args.pdf)
        if document.needs_pass:
            print(json.dumps({"error": "PDF_ENCRYPTED"}))
            return
        pages = []
        for index in range(document.page_count):
            page = document.load_page(index)
            text = page.get_text("text") or ""
            blocks = page.get_text("dict").get("blocks", [])
            text_blocks = [block for block in blocks if block.get("type") == 0]
            image_blocks = [block for block in blocks if block.get("type") == 1]
            page_area = max(float(page.rect.width) * float(page.rect.height), 1.0)
            image_area = 0.0
            for block in image_blocks:
                bbox = block.get("bbox") or [0, 0, 0, 0]
                image_area += max(0.0, float(bbox[2]) - float(bbox[0])) * max(0.0, float(bbox[3]) - float(bbox[1]))
            pages.append({
                "pageNumber": index + 1,
                "text": text,
                "textBlockCount": len(text_blocks),
                "imageCount": len(image_blocks),
                "drawingCount": len(page.get_drawings()),
                "imageCoverageRatio": min(image_area / page_area, 1.0),
                "width": float(page.rect.width),
                "height": float(page.rect.height),
            })
        print(json.dumps({"totalPages": document.page_count, "encrypted": False, "pages": pages}, ensure_ascii=False))
    except fitz.FileDataError:
        print(json.dumps({"error": "PDF_CORRUPTED"}))


def render_pages(args):
    """一次打开 PDF 并仅渲染调用方指定的页。"""
    fitz = load_fitz()
    document = fitz.open(args.pdf)
    if document.needs_pass:
        print(json.dumps({"error": "PDF_ENCRYPTED"}))
        return
    requested = sorted({int(value) for value in args.pages.split(",") if value})
    os.makedirs(args.output, exist_ok=True)
    rendered = []
    for page_number in requested:
        if page_number < 1 or page_number > document.page_count:
            continue
        page = document.load_page(page_number - 1)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
        file_name = f"page-{page_number}.png"
        pixmap.save(os.path.join(args.output, file_name))
        rendered.append({"pageNumber": page_number, "fileName": file_name, "width": pixmap.width, "height": pixmap.height})
    print(json.dumps({"pages": rendered}))


def main():
    """解析受控子命令并执行对应任务。"""
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    check_parser = subparsers.add_parser("check")
    check_parser.set_defaults(handler=check_runtime)
    extract_parser = subparsers.add_parser("extract")
    extract_parser.add_argument("--pdf", required=True)
    extract_parser.set_defaults(handler=extract_text)
    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("--pdf", required=True)
    render_parser.add_argument("--output", required=True)
    render_parser.add_argument("--pages", required=True)
    render_parser.set_defaults(handler=render_pages)
    arguments = parser.parse_args()
    arguments.handler(arguments)


if __name__ == "__main__":
    try:
        main()
    except ModuleNotFoundError:
        print(json.dumps({"error": "PYMUPDF_UNAVAILABLE"}))
        sys.exit(2)
