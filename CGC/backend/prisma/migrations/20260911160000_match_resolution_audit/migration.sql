-- Audit actions for a person settling a match verdict.
--
-- Resolving a verdict is a decision about money: it says this delivery is the
-- one that order was for, or that this line is not backed by anything. Who
-- decided, when, and on what grounds has to be recoverable afterwards, so the
-- two actions get their own audit types rather than being folded into
-- INVOICE_LINE_OVERRIDDEN, which describes something else.
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'MATCH_RESOLVED';
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'MATCH_REOPENED';
