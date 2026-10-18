// OTP and phone-change limits from TZ §7.6
export const OTP_TTL_SEC = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_BRUTEFORCE_BLOCK_MIN = 15;
export const OTP_DAILY_CAP = 5;
export const OTP_MIN_GAP_SEC = 60;
export const PHONE_CHANGE_DAILY_CAP = 3;

// L1: a cost-12 dummy bcrypt hash of a random string. Comparing against it for
// unknown accounts costs the SAME as a real verify, so response timing doesn't
// leak whether an email/phone exists. Nothing can match it.
export const DUMMY_BCRYPT_HASH_COST12 =
  '$2a$12$C6UzMDM.H6dfI/f/IKcEeODuLXk1UT9UyN3Ci7q2ZfP8i8VqQ0y8W';
