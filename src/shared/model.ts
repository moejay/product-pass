export type CaptureKind = "element" | "freehand";
export type SessionStatus = "capturing" | "reviewing" | "complete";
export type DraftDecision = "review" | "accepted" | "skipped";
export type PublishState = "not-published" | "publishing" | "published" | "failed" | "unknown";

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface ElementAnchor { kind: "element"; selector: string; quote: string; rect: Rect }
export interface FreehandAnchor { kind: "freehand"; points: Point[]; bounds: Rect }
export type Anchor = ElementAnchor | FreehandAnchor;

export interface ScreenshotRef { id: string; mimeType: "image/jpeg"; width: number; height: number; createdAt: number }
export interface CaptureViewport { scrollX: number; scrollY: number; width: number; height: number }

export interface Annotation {
  id: string;
  sessionId: string;
  kind: CaptureKind;
  url: string;
  safeUrl: string;
  pageTitle: string;
  text: string;
  contextLabel: string;
  anchor: Anchor;
  screenshot?: ScreenshotRef;
  createdAt: number;
  updatedAt: number;
}

export interface IssueDraft {
  id: string;
  sessionId: string;
  title: string;
  body: string;
  sourceAnnotationIds: string[];
  decision: DraftDecision;
  publishState: PublishState;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewSession {
  id: string;
  title: string;
  status: SessionStatus;
  annotations: Annotation[];
  drafts: IssueDraft[];
  createdAt: number;
  updatedAt: number;
}

export type AIProvider = "openai-compatible" | "codex-subscription";
export type GithubAuthMode = "pat" | "github-app";

export interface Settings {
  showAnnotations: boolean;
  aiProvider: AIProvider;
  aiEndpoint: string;
  aiModel: string;
  codexModel: string;
  githubAuth: GithubAuthMode;
  githubRepo: string;
  githubAppClientId: string;
  githubAppInstallUrl: string;
}

export interface AppState {
  sessions: ReviewSession[];
  activeSessionId: string | null;
  selectedAnnotationId: string | null;
  enabledOrigins: string[];
  settings: Settings;
}

export interface GithubDeviceStatus {
  state: "idle" | "awaiting-user" | "authorized" | "denied" | "expired" | "error";
  connected: boolean;
  expiresAt?: number;
  userCode?: string;
  verificationUri?: string;
  flowExpiresAt?: number;
  message?: string;
}

export interface CodexAuthStatus {
  state: "idle" | "awaiting-user" | "authorized" | "expired" | "error";
  connected: boolean;
  expiresAt?: number;
  userCode?: string;
  verificationUri?: string;
  flowExpiresAt?: number;
  message?: string;
}

export interface CredentialsStatus {
  aiKey: boolean;
  githubToken: boolean;
  codexSubscription: CodexAuthStatus;
  githubApp: GithubDeviceStatus;
}

export type RequestMessage =
  | { type: "BOOTSTRAP" }
  | { type: "CREATE_SESSION"; title: string }
  | { type: "SET_ACTIVE_SESSION"; sessionId: string }
  | { type: "SET_GITHUB_REPO"; repo: string }
  | { type: "SEARCH_GITHUB_REPOS"; query: string }
  | { type: "FINISH_SESSION"; sessionId: string }
  | { type: "DELETE_SESSION"; sessionId: string }
  | { type: "ENABLE_ORIGIN"; origin: string; tabId: number }
  | { type: "BEGIN_CAPTURE"; mode: CaptureKind; tabId: number }
  | { type: "GET_PAGE"; url: string }
  | { type: "SELECT_ANNOTATION"; annotationId: string; url: string }
  | { type: "CLEAR_ANNOTATION_SELECTION" }
  | { type: "SET_ANNOTATIONS_VISIBLE"; visible: boolean }
  | { type: "GET_SCREENSHOT"; annotationId: string }
  | { type: "PAGE_CHANGED"; url: string }
  | { type: "SAVE_ANNOTATION"; annotation: Omit<Annotation, "id" | "sessionId" | "createdAt" | "updatedAt" | "safeUrl" | "screenshot"> & { viewport: CaptureViewport } }
  | { type: "UPDATE_ANNOTATION"; annotationId: string; text: string }
  | { type: "DELETE_ANNOTATION"; annotationId: string }
  | { type: "GENERATE_DRAFTS" }
  | { type: "UPDATE_DRAFT"; draftId: string; title: string; body: string }
  | { type: "SET_DRAFT_DECISION"; draftId: string; decision: DraftDecision }
  | { type: "PUBLISH_DRAFT"; draftId: string }
  | { type: "SAVE_SETTINGS"; settings: Settings; aiKey?: string; githubToken?: string }
  | { type: "START_GITHUB_DEVICE_FLOW" }
  | { type: "CANCEL_GITHUB_DEVICE_FLOW" }
  | { type: "DISCONNECT_GITHUB_APP" }
  | { type: "START_CODEX_DEVICE_FLOW" }
  | { type: "CANCEL_CODEX_DEVICE_FLOW" }
  | { type: "DISCONNECT_CODEX" };

export interface PageAnnotations { annotations: Annotation[]; visible: boolean }

export interface Bootstrap {
  state: AppState;
  credentials: CredentialsStatus;
  tab: { id?: number; url: string; title: string; supported: boolean; enabled: boolean };
}
