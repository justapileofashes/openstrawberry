export type UpdateStatus = "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";

export type UpdateSnapshot = {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  progress?: number;
  message: string;
};

export const DISABLED_UPDATE_SNAPSHOT: UpdateSnapshot = {
  status: "disabled",
  currentVersion: "",
  message: "In-app updates activate after OpenStrawberry publishes its first signed stable release."
};
