export type PasswordRecoveryState = {
  status: "idle" | "error" | "success";
  message: string;
};

export const PASSWORD_RECOVERY_MESSAGE = "If that email belongs to an eligible People Hub account, you will receive a password reset link. Check your inbox and junk folder.";
export const PASSWORD_RECOVERY_INVALID = "This reset link is invalid or has expired. Request a new link.";
export const PASSWORD_RECOVERY_PASSWORD_RULE = "Use 12–128 characters with upper and lower case, a number and a symbol.";
export const PASSWORD_RECOVERY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PASSWORD_RECOVERY_PASSWORD_PATTERN = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,128}$/;
export const PEOPLE_HUB_ORIGIN = "https://mam-team-management-system-ten.vercel.app";
