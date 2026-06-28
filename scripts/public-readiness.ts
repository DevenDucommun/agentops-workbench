import { formatPublicationScanResult, scanPublication } from "../src/publicationScan";

const findings = scanPublication();
const output = formatPublicationScanResult(findings);
if (findings.length > 0) {
  console.error(output.trimEnd());
  process.exit(1);
}

console.log(output.trimEnd());
