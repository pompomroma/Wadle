import { detectNetworkIsolation, hasBinary } from "./exec.js";

export interface Capability {
  id: string;
  label: string;
  /** Binaries that must all be present for this capability to be usable. */
  binaries: string[];
  available: boolean;
  /** What still works when this is missing — never silently pretend. */
  degradedTo: string;
}

export interface CapabilityReport {
  languages: Capability[];
  binaryTargets: Capability[];
  conversion: Capability[];
  networkIsolation: boolean;
  generatedAt: number;
}

const LANGUAGES: Array<Omit<Capability, "available">> = [
  {
    id: "node",
    label: "JavaScript / TypeScript",
    binaries: ["node"],
    degradedTo: "syntax check only",
  },
  {
    id: "python",
    label: "Python",
    binaries: ["python3"],
    degradedTo: "syntax check only",
  },
  { id: "go", label: "Go", binaries: ["go"], degradedTo: "syntax check only" },
  {
    id: "rust",
    label: "Rust",
    binaries: ["cargo"],
    degradedTo: "syntax check only",
  },
  {
    id: "c",
    label: "C / C++",
    binaries: ["gcc"],
    degradedTo: "syntax check only",
  },
  {
    id: "java",
    label: "Java",
    binaries: ["javac"],
    degradedTo: "syntax check only",
  },
  { id: "php", label: "PHP", binaries: ["php"], degradedTo: "syntax check only" },
  {
    id: "ruby",
    label: "Ruby",
    binaries: ["ruby"],
    degradedTo: "syntax check only",
  },
  {
    id: "dotnet",
    label: "C# / .NET",
    binaries: ["dotnet"],
    degradedTo: "syntax check only",
  },
];

const BINARY_TARGETS: Array<Omit<Capability, "available">> = [
  {
    id: "windows-exe",
    label: "Windows .exe (cross-compile)",
    binaries: ["x86_64-w64-mingw32-gcc"],
    degradedTo:
      "native Linux ELF binaries; .exe inspection and resource patching still work",
  },
  {
    id: "gba-rom",
    label: "Game Boy Advance .gba ROM",
    binaries: ["arm-none-eabi-gcc"],
    degradedTo:
      "ROM header inspection, asset extraction and IPS/UPS/BPS patching still work",
  },
  {
    id: "native-elf",
    label: "Native Linux binary",
    binaries: ["gcc"],
    degradedTo: "unavailable",
  },
];

const CONVERSION: Array<Omit<Capability, "available">> = [
  {
    id: "documents",
    label: "Documents (docx / xlsx / pptx / odt / pdf)",
    binaries: ["soffice"],
    degradedTo: "text and data formats only",
  },
  {
    id: "media",
    label: "Audio / video",
    binaries: ["ffmpeg"],
    degradedTo: "unavailable",
  },
  {
    id: "images",
    label: "Images",
    binaries: ["python3"],
    degradedTo: "unavailable",
  },
  {
    id: "archives",
    label: "Archives (zip / tar / gz)",
    binaries: ["tar"],
    degradedTo: "zip only, via the built-in reader",
  },
];

let cached: CapabilityReport | null = null;

async function resolveGroup(
  specs: Array<Omit<Capability, "available">>,
): Promise<Capability[]> {
  return Promise.all(
    specs.map(async (spec) => ({
      ...spec,
      available: (
        await Promise.all(spec.binaries.map((binary) => hasBinary(binary)))
      ).every(Boolean),
    })),
  );
}

/**
 * Probe what this machine can actually do. The UI shows this verbatim: a
 * capability that is missing is reported as missing rather than attempted and
 * failed at the last step of a long build.
 */
export async function probeCapabilities(
  refresh = false,
): Promise<CapabilityReport> {
  if (cached && !refresh) return cached;
  // The isolation probe actually runs `unshare -rn`, rather than checking that
  // the binary exists. A container can have the binary and still refuse the
  // user namespace, and reporting that as available would be exactly the kind
  // of claim this report exists to avoid.
  const [languages, binaryTargets, conversion, isolation] = await Promise.all([
    resolveGroup(LANGUAGES),
    resolveGroup(BINARY_TARGETS),
    resolveGroup(CONVERSION),
    detectNetworkIsolation(),
  ]);
  cached = {
    languages,
    binaryTargets,
    conversion,
    networkIsolation: isolation === "unshare",
    generatedAt: Date.now(),
  };
  return cached;
}

/** Language ids that can be fully built, run and tested here. */
export async function verifiableLanguages(): Promise<Set<string>> {
  const report = await probeCapabilities();
  return new Set(
    report.languages.filter((lang) => lang.available).map((lang) => lang.id),
  );
}
