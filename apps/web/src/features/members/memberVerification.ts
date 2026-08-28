export function memberVerificationCode(uid: string) {
  const compact = uid.replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase().padStart(8, "0");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function matchesMemberVerificationCode(uid: string, candidate: string) {
  return candidate.replace(/[^a-z0-9]/gi, "").toUpperCase() === memberVerificationCode(uid).replace("-", "");
}
