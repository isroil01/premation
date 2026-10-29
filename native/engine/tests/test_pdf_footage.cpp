// PDF / Illustrator footage (scene/pdf_render.hpp): the first page sized in
// points, drawn at the display size asked for, transparent where the page is
// unpainted, through the SVG path's routing.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "pdf_render.hpp"
#include "svg_layer.hpp"

namespace fs = std::filesystem;
using namespace premation::scene;

namespace {

/// A one-page PDF, 200 × 100 pt, with a red rectangle at (20, 10) 60 × 40 (PDF y-up).
std::string write_pdf(const fs::path& p) {
  const std::string content = "1 0 0 rg 20 50 60 40 re f";
  std::vector<std::string> objs = {
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>",
      "<< /Length " + std::to_string(content.size()) + " >>\nstream\n" + content + "\nendstream",
  };
  std::string out = "%PDF-1.4\n";
  std::vector<std::size_t> at;
  for (std::size_t i = 0; i < objs.size(); ++i) {
    at.push_back(out.size());
    out += std::to_string(i + 1) + " 0 obj\n" + objs[i] + "\nendobj\n";
  }
  const std::size_t xref = out.size();
  out += "xref\n0 " + std::to_string(objs.size() + 1) + "\n0000000000 65535 f \n";
  for (const std::size_t a : at) {
    std::string n = std::to_string(a);
    out += std::string(10 - n.size(), '0') + n + " 00000 n \n";
  }
  out += "trailer\n<< /Size " + std::to_string(objs.size() + 1) + " /Root 1 0 R >>\nstartxref\n" + std::to_string(xref) + "\n%%EOF\n";
  std::ofstream(p, std::ios::binary) << out;
  return p.generic_string();
}

const std::uint8_t* px(const premation::raster::RasterOutput& r, std::uint32_t x, std::uint32_t y) {
  return r.rgba.data() + (std::size_t{y} * r.width + x) * 4;
}

}  // namespace

TEST_CASE("PDF footage: points are pixels, drawn sharp at the display size, clear where unpainted", "[pdf]") {
  const fs::path dir = fs::temp_directory_path() / "premation-pdf-tests";
  fs::create_directories(dir);
  const std::string path = write_pdf(dir / "Card.pdf");

  CHECK(is_pdf_path(path));
  CHECK(is_pdf_path("file:///C:/art/Logo.AI"));
  CHECK_FALSE(is_pdf_path("data:application/pdf;base64,AAAA"));
  CHECK(is_svg_src(path));  // routed through the vector-document path

  const PdfFacts f = pdf_file_facts(path);
  INFO(f.error);
  REQUIRE(f.ok);
  CHECK(f.width == 200);
  CHECK(f.height == 100);
  CHECK(f.pages == 1);

  const auto native = rasterize_svg_src(path, std::nullopt, path, 0, 0);
  INFO(native.error);
  REQUIRE(native.ok);
  CHECK(native.width == 200);
  CHECK(native.height == 100);
  // Inside the rectangle (page y 50..90 → image rows 10..50): opaque red.
  CHECK(px(native, 50, 30)[0] == 255);
  CHECK(px(native, 50, 30)[1] == 0);
  CHECK(px(native, 50, 30)[3] == 255);
  // Outside: transparent (premultiplied zero).
  CHECK(px(native, 150, 80)[3] == 0);
  CHECK(px(native, 150, 80)[0] == 0);

  // At a display step: the long edge as asked, still crisp (no blur to sample).
  const auto big = rasterize_svg_src(path, std::nullopt, path, 0, 2048);
  REQUIRE(big.ok);
  CHECK(big.width == 2048);
  CHECK(big.height == 1024);
  CHECK(px(big, 512, 300)[3] == 255);
  CHECK(px(big, 1500, 900)[3] == 0);

  const auto missing = rasterize_pdf_file((dir / "nope.pdf").generic_string(), 0);
  CHECK_FALSE(missing.ok);
  std::ofstream(dir / "Broken.ai", std::ios::binary) << "%!PS-Adobe-3.0 not a pdf";
  const PdfFacts broken = pdf_file_facts((dir / "Broken.ai").generic_string());
  CHECK_FALSE(broken.ok);
  CHECK(broken.error.find("Illustrator") != std::string::npos);
  std::error_code ec;
  fs::remove_all(dir, ec);
}
