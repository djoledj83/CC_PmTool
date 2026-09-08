-- Allow pinning tickets (reuses the generic UserPin table). Additive.
ALTER TYPE "UserPinKind" ADD VALUE IF NOT EXISTS 'TICKET';
