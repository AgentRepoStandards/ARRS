import type { ChangesetCapability, ChangesetSnapshot } from "./changeset.js";
export const commandNames = ["setup", "dev", "check", "test", "verify", "build"] as const;
export type CommandName = (typeof commandNames)[number];
export const risks = ["R0", "R1", "R2", "R3", "R4"] as const;
export type Risk = (typeof risks)[number];
/** Independently selected pre-change controls; the reference is not authentication. */
export interface PolicyBaseline {
  root: string;
  sha256: string;
}
export interface Command {
  argv: string[];
  timeoutSeconds?: number;
}
export interface ArrsConfig {
  schemaVersion: "0.1";
  project: { name: string; runtimes?: Record<string, string> };
  commands: Partial<Record<CommandName, Command>>;
  verifyTargets: Record<string, Command>;
  knowledge: {
    architecture: string;
    product: string;
    features: string;
    decisions: string;
  };
  architecture: { policy: string };
  riskPolicy: string;
  proof: {
    requiredChecks: CommandName[];
    behavioralRequiredFrom: Risk;
    evidenceDir: string;
  };
  skills: { path: string };
  ci: { workflow: string };
  security: { exceptions: string };
  work?: { provider: string; path: string };
}
export interface FeatureMap {
  schemaVersion: "0.1";
  id: string;
  goal: string;
  owners: string[];
  entryPoints: string[];
  implementation: string[];
  boundaries: string[];
  dependencies: string[];
  domainTerms: string[];
  invariants: string[];
  sensitivity: "none" | "internal" | "sensitive" | "critical";
  acceptance: string[];
  verification: { target: string };
  risk: Risk;
  related: string[];
}
export interface ArchitecturePolicy {
  schemaVersion: "0.1";
  adapter?: {
    id: string;
    version: string;
    packageRoots?: string[];
    runtime?: Command;
  };
  modules: Array<{
    id: string;
    path: string;
    allows: string[];
    public: string[];
    generated?: boolean;
  }>;
}
export interface RiskPolicy {
  schemaVersion: "0.1";
  classes: Record<
    Risk,
    {
      autonomy: "unattended" | "review" | "human";
      requiredChecks: CommandName[];
      independentReview: boolean;
      humanApproval: boolean;
    }
  >;
  sensitivePaths: Array<{ path: string; risk: Risk; reason: string }>;
}
export type ProofPhase =
  "before" | "check" | "test" | "behavior" | "after" | "mechanical";
export interface ProofStep {
  phase: ProofPhase;
  command: CommandName;
  target?: string;
  expectExitCode: number;
  criterion?: string;
}
export interface ProofPlan {
  schemaVersion: "0.1";
  task: string;
  category: "bug" | "feature" | "refactor" | "docs";
  risk: Risk;
  scope: string[];
  acceptance: string[];
  steps: ProofStep[];
  residualRisks: string[];
  deviations: string[];
  policyBaseline?: PolicyBaseline;
  authorization?: { humanApproval: string };
  changeset?: ChangesetCapability;
  review?: { independent: string; humanApproval?: string };
}
export interface ProofReview {
  schemaVersion: "0.1";
  stage: "implementation";
  proofId: string;
  manifestSha256: string;
  scopeHashes: Record<string, string>;
  createdAt: string;
  policyBaseline?: PolicyBaseline;
  independent?: string;
  humanApproval?: string;
}
export interface ProofResult extends ProofStep {
  argv: string[];
  exitCode: number;
  durationMs: number;
  log: string;
  sha256: string;
}
export interface ProofManifest extends ProofPlan {
  id: string;
  createdAt: string;
  status: "passed" | "failed";
  results: ProofResult[];
  scopeHashes: Record<string, string>;
  changesetSnapshot?: ChangesetSnapshot;
}
export type DiagnosticStatus =
  "passed" | "failed" | "incomplete" | "blocked" | "not-evaluated" | "unsupported";
export interface AuditControl {
  id: string;
  level: number;
  passed: boolean;
  detail: string;
  remediation: string;
  status: DiagnosticStatus;
  dependsOn?: string[];
}
export interface ArchitectureDiagnostic {
  adapter: string;
  version: string;
  qualification: string;
  sourceFileCount: number;
  scannedFileCount: number;
  unscannedFiles: string[];
  scope: string[];
  errors: string[];
  guard?: "passed" | "failed" | "blocked";
}
export interface AuditReport {
  architecture?: ArchitectureDiagnostic;
  schemaVersion: "0.1";
  level: number;
  controls: AuditControl[];
  warnings: string[];
  proofHistoryWarnings?: string[];
}
export interface DoctorReport {
  architecture?: ArchitectureDiagnostic;
  schemaVersion: "0.1";
  healthy: boolean;
  checks: Array<{
    id: string;
    passed: boolean;
    detail: string;
    remediation: string;
    status: DiagnosticStatus;
  }>;
  warnings: string[];
}
