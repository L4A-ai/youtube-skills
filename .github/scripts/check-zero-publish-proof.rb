#!/usr/bin/env ruby

require "json"
require "digest"
require "rexml/document"
require "rexml/xpath"
require "zlib"

repo_dir = File.expand_path("../..", __dir__)
readme_path = File.join(repo_dir, "README.md")
svg_path = File.join(repo_dir, "media", "youtube-zero-publish-proof.svg")
png_path = File.join(repo_dir, "media", "youtube-zero-publish-proof.png")

def gate(condition, message)
  raise "zero-publish proof contract: #{message}" unless condition
end

def compact_space(value)
  value.to_s.gsub(/\s+/, " ").strip
end

def fact(result, path)
  path.reduce(result) do |value, key|
    gate(value.is_a?(Hash) && value.key?(key), "README expected stdout is missing #{path.join(".")}")
    value.fetch(key)
  end
end

def png_chunks(source)
  signature = "\x89PNG\r\n\x1a\n".b
  gate(source.start_with?(signature), "PNG signature is invalid")

  chunks = []
  offset = signature.bytesize
  until offset == source.bytesize
    gate(offset + 12 <= source.bytesize, "PNG has a truncated chunk header")
    length = source.byteslice(offset, 4).unpack1("N")
    type = source.byteslice(offset + 4, 4)
    gate(type.match?(/\A[A-Za-z]{4}\z/), "PNG chunk type is invalid")

    data_start = offset + 8
    data_end = data_start + length
    crc_end = data_end + 4
    gate(crc_end <= source.bytesize, "PNG #{type} chunk is truncated")

    data = source.byteslice(data_start, length)
    recorded_crc = source.byteslice(data_end, 4).unpack1("N")
    calculated_crc = Zlib.crc32(type + data)
    gate(recorded_crc == calculated_crc, "PNG #{type} chunk CRC is invalid")

    chunks << [type, data]
    offset = crc_end
    break if type == "IEND"
  end

  gate(offset == source.bytesize, "PNG contains trailing bytes after IEND")
  chunks
end

readme = File.read(readme_path, encoding: "UTF-8")
svg_source = File.read(svg_path, encoding: "UTF-8")
png_source = File.binread(png_path)

gate(Digest::SHA256.hexdigest(svg_source) == "eb69d9f586b86a3dc8d6591e33b291f3b7a6e209578ae7ec72e568ce42feecab",
  "SVG bytes changed; re-review the rendered proof and deliberately update its locked digest")
gate(Digest::SHA256.hexdigest(png_source) == "50e48c38a5a04588bb1a27c74f09e9c49abb7141b0a673b540f2efdb55c08bb0",
  "PNG bytes changed; re-review the rendered proof and deliberately update its locked digest")

stdout_matches = readme.scan(/Expected stdout \(one line\):\n\n```json\n([^\n]+)\n```/)
gate(stdout_matches.length == 1, "README must contain exactly one one-line expected stdout block")
expected_stdout = JSON.parse(stdout_matches.first.first)

expected_facts = {
  ["schema_version"] => "1.0",
  ["skill_version"] => "0.1.0",
  ["fixture"] => "generated-360x640-h264-aac",
  ["status"] => "ok",
  ["inspection", "displayed_dimensions", "width"] => 360,
  ["inspection", "displayed_dimensions", "height"] => 640,
  ["inspection", "duration_seconds"] => 1,
  ["inspection", "video_codec"] => "h264",
  ["inspection", "audio_codec"] => "aac",
  ["inspection", "shorts_candidate"] => true,
  ["plan", "safe_to_publish"] => true,
  ["plan", "privacy"] => "private",
  ["plan", "notify_subscribers"] => false,
  ["plan", "executed"] => false,
  ["safety", "oauth_used"] => false,
  ["safety", "network_guard_armed"] => true,
  ["safety", "network_requests"] => 0,
  ["safety", "youtube_writes"] => 0,
  ["safety", "plan_local_writes"] => 0,
  ["safety", "config_dir_created"] => false,
  ["safety", "credential_files_created"] => false,
  ["safety", "temporary_fixture_written"] => true,
  ["safety", "temporary_artifacts_removed"] => true,
  ["passed"] => true,
}
expected_facts.each do |path, expected|
  gate(fact(expected_stdout, path) == expected,
    "README expected stdout changed #{path.join(".")}")
end

chunks = png_chunks(png_source)
gate(chunks.first&.first == "IHDR", "PNG must begin with IHDR")
gate(chunks.count { |type, _data| type == "IHDR" } == 1, "PNG must contain exactly one IHDR")
gate(chunks.count { |type, _data| type == "IEND" } == 1, "PNG must contain exactly one IEND")
gate(chunks.any? { |type, _data| type == "IDAT" }, "PNG must contain image data")
gate(chunks.last&.first == "IEND", "PNG must end with IEND")

ihdr = chunks.first.last
gate(ihdr.bytesize == 13, "PNG IHDR length must be 13 bytes")
png_width, png_height, bit_depth, color_type, compression, filter, interlace = ihdr.unpack("NNC5")
gate([png_width, png_height] == [1200, 630], "PNG dimensions must be exactly 1200x630")
gate([bit_depth, color_type] == [8, 6], "PNG must remain 8-bit RGBA")
gate([compression, filter, interlace] == [0, 0, 0],
  "PNG must use the standard compression/filter methods and remain non-interlaced")

gate(!svg_source.match?(/<!DOCTYPE|<!ENTITY/i), "SVG must not contain a doctype or entity declaration")
gate(!svg_source.include?("<?"), "SVG must not contain processing instructions")

begin
  svg_document = REXML::Document.new(svg_source)
rescue REXML::ParseException => error
  raise "zero-publish proof contract: SVG is not well-formed XML: #{error.message.lines.first.strip}"
end

svg = svg_document.root
gate(svg&.name == "svg", "SVG root element must be svg")
gate(svg.attributes["xmlns"] == "http://www.w3.org/2000/svg", "SVG namespace changed")
gate(svg.attributes["width"] == "1200", "SVG width must be exactly 1200")
gate(svg.attributes["height"] == "630", "SVG height must be exactly 630")
gate(svg.attributes["viewBox"] == "0 0 1200 630", "SVG viewBox must be exactly 0 0 1200 630")
gate(svg.attributes["role"] == "img", "SVG must retain role=img")

allowed_elements = %w[
  svg title desc metadata defs linearGradient stop filter feDropShadow rect circle text path line
]
elements = REXML::XPath.match(svg_document, "//*")
gate(elements.all? { |element| allowed_elements.include?(element.name) },
  "SVG contains an element outside the static allowlist")
gate(elements.all? { |element| element.namespace == "http://www.w3.org/2000/svg" },
  "SVG elements must stay in the canonical SVG namespace")

ids = {}
elements.each do |element|
  if element.attributes["id"]
    gate(!ids.key?(element.attributes["id"]), "SVG element ids must be unique")
    ids[element.attributes["id"]] = true
  end

  element.attributes.each_attribute do |attribute|
    name = attribute.expanded_name
    value = attribute.value
    gate(!name.match?(/\Aon/i), "SVG event-handler attributes are forbidden")
    gate(name != "style", "SVG inline style attributes are forbidden")
    next if name == "xmlns"

    gate(!value.match?(/(?:https?|data|javascript|file):/i),
      "SVG must not reference external or executable resources")
    value.scan(/url\(([^)]+)\)/).flatten.each do |reference|
      gate(reference.match?(/\A#[A-Za-z][A-Za-z0-9_.:-]*\z/),
        "SVG url() references must be local fragments")
    end
    if %w[href xlink:href].include?(name)
      gate(value.match?(/\A#[A-Za-z][A-Za-z0-9_.:-]*\z/),
        "SVG links must be local fragments")
    end
  end
end

elements.each do |element|
  element.attributes.each_attribute do |attribute|
    attribute.value.scan(/url\(#([A-Za-z][A-Za-z0-9_.:-]*)\)/).flatten.each do |target|
      gate(ids.key?(target), "SVG references missing id ##{target}")
    end
  end
end

label_targets = svg.attributes["aria-labelledby"].to_s.split
gate(label_targets == %w[title description], "SVG aria-labelledby targets changed")
gate(label_targets.all? { |target| ids.key?(target) }, "SVG aria-labelledby target is missing")

title_elements = elements.select { |element| element.name == "title" }
description_elements = elements.select { |element| element.name == "desc" }
gate(title_elements.length == 1, "SVG must contain exactly one title")
gate(description_elements.length == 1, "SVG must contain exactly one description")
gate(compact_space(title_elements.first.texts.join(" ")) == "Zero-publish YouTube Shorts safety proof",
  "SVG accessible title changed")
gate(compact_space(description_elements.first.texts.join(" ")) ==
  "A zero-input verifier generated and removed a one-second 360 by 640 H.264 and AAC fixture after local Shorts inspection and dry planning. The plan stayed private, did not notify subscribers, did not execute, made zero network requests, made zero plan writes, and created no configuration directory.",
  "SVG accessible description changed")

metadata_elements = elements.select { |element| element.name == "metadata" }
gate(metadata_elements.length == 1, "SVG must contain exactly one metadata element")
metadata = compact_space(metadata_elements.first.texts.join(" "))

output_fields = [
  ["schema_version", ["schema_version"]],
  ["skill_version", ["skill_version"]],
  ["fixture", ["fixture"]],
  ["status", ["status"]],
  ["displayed_width", ["inspection", "displayed_dimensions", "width"]],
  ["displayed_height", ["inspection", "displayed_dimensions", "height"]],
  ["duration_seconds", ["inspection", "duration_seconds"]],
  ["video_codec", ["inspection", "video_codec"]],
  ["audio_codec", ["inspection", "audio_codec"]],
  ["shorts_candidate", ["inspection", "shorts_candidate"]],
  ["safe_to_publish", ["plan", "safe_to_publish"]],
  ["privacy", ["plan", "privacy"]],
  ["notify_subscribers", ["plan", "notify_subscribers"]],
  ["executed", ["plan", "executed"]],
  ["oauth_used", ["safety", "oauth_used"]],
  ["network_guard_armed", ["safety", "network_guard_armed"]],
  ["network_requests", ["safety", "network_requests"]],
  ["youtube_writes", ["safety", "youtube_writes"]],
  ["plan_local_writes", ["safety", "plan_local_writes"]],
  ["config_dir_created", ["safety", "config_dir_created"]],
  ["credential_files_created", ["safety", "credential_files_created"]],
  ["temporary_fixture_written", ["safety", "temporary_fixture_written"]],
  ["temporary_artifacts_removed", ["safety", "temporary_artifacts_removed"]],
  ["passed", ["passed"]],
]
expected_output = "Output: " + output_fields.map do |label, path|
  "#{label}=#{fact(expected_stdout, path)}"
end.join("; ") + "."

gate(metadata.include?("Observed: 2026-08-07."), "SVG observed date changed or is missing")
gate(metadata.include?("Command: node examples/verify-zero-publish.mjs (no arguments)."),
  "SVG must identify the exact zero-input verifier command")
gate(metadata.include?(
  "Input: generated temporary fixture; duration_seconds=1; width=360; height=640; video_codec=h264; audio_codec=aac.",
), "SVG input facts do not match the verifier fixture")
gate(metadata.include?(expected_output), "SVG output facts do not match README expected stdout")

evidence_boundary = "Evidence boundary: local capability and safety-contract proof only; not an upload, Shorts Feed placement, install, adoption, or user-attribution claim."
gate(metadata.include?(evidence_boundary), "SVG evidence boundary changed or is missing")

visible_text = elements.select { |element| element.name == "text" }
  .flat_map(&:texts).map { |text| compact_space(text) }.reject(&:empty?)
expected_visible_text = [
  "YOUTUBE SHORTS PUBLISH / LOCAL PROOF",
  "Test the upload guard",
  "without uploading.",
  "One zero-input command / local inspect + dry plan",
  "MEDIA INPUT",
  "360 x 640",
  "1.0 sec / H.264 + AAC",
  "SHORTS CANDIDATE",
  "DRY-PLAN EVIDENCE",
  "executed",
  "false",
  "network requests",
  "0",
  "plan writes",
  "0",
  "config created",
  "false",
  "DRY PLAN PASSED",
  "PRIVATE",
  "NOTIFY: FALSE",
  "No OAuth / No Google API / Fixture removed",
  "OBSERVED 2026-08-07",
  "“Safe to publish” means local checks passed; it does not mean a video was uploaded.",
]
gate(visible_text == expected_visible_text, "SVG visible evidence text changed")

alt_text = "Zero-publish proof: a generated 360x640 fixture passed local Shorts inspection, and the dry plan reported no execution, network requests, plan writes, configuration writes, or upload"
proof_embed = "[![#{alt_text}](media/youtube-zero-publish-proof.png)](media/youtube-zero-publish-proof.svg)"
gate(readme.scan(proof_embed).length == 1,
  "README must embed the PNG exactly once and link it to the SVG source")
gate(compact_space(readme).include?(
  "This dated card is local capability and safety-contract evidence, not install, adoption, live-upload, or user-attribution evidence.",
), "README must state the proof card's evidence boundary")

puts "ok: zero-publish SVG/PNG is safe, 1200x630, verifier-backed, dated, and source-linked"
