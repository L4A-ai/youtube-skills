#!/usr/bin/env ruby

require "yaml"

repo_dir = File.expand_path("../..", __dir__)
template_path = File.join(repo_dir, ".github", "ISSUE_TEMPLATE", "zero-publish-evaluation.yml")
readme_path = File.join(repo_dir, "README.md")
skill_path = File.join(repo_dir, "skills", "youtube-shorts-publish", "SKILL.md")
report_url = "https://github.com/L4A-ai/youtube-skills/issues/new?template=zero-publish-evaluation.yml"

def gate(condition, message)
  raise "zero-publish report contract: #{message}" unless condition
end

form = YAML.safe_load(
  File.read(template_path),
  permitted_classes: [],
  permitted_symbols: [],
  aliases: false,
)
gate(form.is_a?(Hash), "issue form must parse as a mapping")
gate(form["labels"] == ["tester-report"], "form must apply only tester-report")

body = form.fetch("body")
ids = body.map { |item| item["id"] }.compact
fields = body.each_with_object({}) do |item, indexed|
  indexed[item.fetch("id")] = item if item["id"]
end
gate(fields.length == ids.length, "field ids must be unique")

completion = fields.fetch("completion")
completion_options = completion.fetch("attributes").fetch("options")
gate(completion["type"] == "dropdown", "completion must be a dropdown")
gate(completion.dig("attributes", "label") == "Evaluation completion", "completion heading changed")
gate(completion_options == [
  "Installed youtube-shorts-publish and ran the zero-publish evaluation",
  "Installed, but did not run the evaluation",
  "Installation or evaluation failed before completion",
], "completion states changed")
gate(completion.dig("attributes", "multiple") == false, "completion must allow exactly one choice")
gate(!completion.fetch("attributes").key?("default"), "completion must require an explicit choice")
gate(completion.dig("validations", "required") == true, "completion must be required")

expected = fields.fetch("expected-fields")
gate(expected["type"] == "dropdown", "expected-fields must be a dropdown")
gate(expected.dig("attributes", "label") == "Did every expected field match?", "expected-fields heading changed")
gate(expected.fetch("attributes").fetch("options") == [
  "Yes - all expected fields matched",
  "No - one or more expected fields differed",
  "Not checked - evaluation did not complete",
], "expected-fields choices changed")
gate(expected.dig("attributes", "multiple") == false, "expected-fields must allow exactly one choice")
gate(!expected.fetch("attributes").key?("default"), "expected-fields must require an explicit choice")
gate(expected.dig("validations", "required") == true, "expected-fields must be required")

%w[mismatch observed-evidence environment].each do |id|
  gate(fields.fetch(id).dig("validations", "required") == true, "#{id} must be required")
end

safety = fields.fetch("safety-and-integrity")
safety_options = safety.fetch("attributes").fetch("options")
gate(safety["type"] == "checkboxes", "safety-and-integrity must use checkboxes")
gate(safety_options.length == 5, "five safety and evidence-integrity confirmations are required")
gate(safety_options.all? { |option| option["required"] == true }, "every safety confirmation must be required")
gate(safety_options.none? { |option| option.key?("default") }, "attestations must never be preselected")
safety_text = safety_options.map { |option| option.fetch("label") }.join("\n")
%w[OAuth upload privacy].each do |term|
  gate(safety_text.downcase.include?(term.downcase), "safety confirmations must mention #{term}")
end
gate(safety_text.include?("otherwise I stopped before it ran"),
  "incomplete attempts must not claim the verifier ran")

completed_attestation = "If I selected the completed outcome, I independently installed `youtube-shorts-publish` and actually ran `node examples/verify-zero-publish.mjs` for my own non-internal purpose; otherwise I selected a truthful incomplete or failed outcome and do not claim a completed run."
eligibility_attestation = "I am not a maintainer of `youtube-skills` or `youtube-shorts-publish`, not a teammate of a maintainer, and not an internal tester for this project."
gate(safety_options.any? { |option| option["label"] == completed_attestation },
  "independent installed-and-ran attestation is missing")
gate(safety_options.any? { |option| option["label"] == eligibility_attestation },
  "maintainer, teammate, and internal-tester exclusion is missing")

intro = body.select { |item| item["type"] == "markdown" }
  .map { |item| item.dig("attributes", "value") }.compact.join("\n")
gate(intro.include?("Installed youtube-shorts-publish and ran the zero-publish evaluation"),
  "count eligibility must name the skill and actual run")
gate(intro.include?("label alone is not evidence"), "tester-report label must not imply completion")

readme = File.read(readme_path)
readme_copy = readme.gsub(/\s+/, " ")
gate(readme.include?(report_url), "README must link the form")
gate(readme_copy.include?("independently installed and actually ran `youtube-shorts-publish`"),
  "README must state the completed evidence boundary")
gate(readme_copy.include?("not a maintainer, a maintainer's teammate, or an internal tester"),
  "README must state the internal-user exclusion")
gate(readme.include?("node examples/verify-zero-publish.mjs"), "README must expose the zero-input verifier")

skill = File.read(skill_path)
skill_copy = skill.gsub(/\s+/, " ")
gate(skill.include?(report_url), "installed SKILL.md must link the structured tester form")
gate(skill_copy.include?("independently installed and actually ran `youtube-shorts-publish`"),
  "installed SKILL.md must state the completed evidence boundary")
gate(skill_copy.include?("not a maintainer, a maintainer's teammate, or an internal tester"),
  "installed SKILL.md must state the internal-user exclusion")
gate(skill.include?("node examples/verify-zero-publish.mjs"),
  "installed SKILL.md must expose the zero-input verifier")

observed = fields.fetch("observed-evidence").dig("attributes", "placeholder")
%w[schema_version skill_version plan_local_writes passed].each do |term|
  gate(observed.include?(term), "observed evidence placeholder must include #{term}")
end
observed_description = fields.fetch("observed-evidence").dig("attributes", "description")
gate(observed_description.include?("installation failed first"),
  "install failures must have a truthful evidence path")

puts "ok: zero-publish form requires an explicit named-skill run and non-internal tester eligibility"
