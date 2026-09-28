// Effective decision derivation. Worker B owns this.
//
// A correction `set` beats every model version until the owner clears it. A
// cleared correction re-exposes the current classification. Corrections never
// acquire a fabricated probability of 1; they carry `null` confidence so the
// distinction between "the model was sure" and "the owner said so" survives.

import type { Answers, Correction, CorrectionChange, Question } from "./domain";

export function latestCorrections(
  corrections: readonly Correction[],
): Map<Question, CorrectionChange> {
  const best = new Map<Question, CorrectionChange>();
  let bestRevision = -1;

  for (const correction of corrections) {
    if (correction.revision <= bestRevision) continue;
    bestRevision = correction.revision;
    for (const change of correction.changes) {
      if (change.operation === "clear") {
        best.delete(change.question);
      } else {
        best.set(change.question, change);
      }
    }
  }
  return best;
}

export interface EffectiveDecision {
  answers: Answers;
  correctionRevision: number;
  correctedQuestions: readonly Question[];
}

export function effectiveDecision(
  classificationAnswers: Answers,
  corrections: readonly Correction[],
): EffectiveDecision {
  const changes = latestCorrections(corrections);
  const answers = structuredClone(classificationAnswers) as Answers;
  const correctedQuestions: Question[] = [];

  for (const [question, change] of changes) {
    if (change.operation !== "set") continue;
    const current = answers[question];
    (answers as Record<Question, unknown>)[question] = {
      state: "value",
      value: change.value,
      // Owner assertion, not model certainty.
      confidence: null,
      distribution: current.state === "value" ? current.distribution : null,
    } as Answers[Question];
    correctedQuestions.push(question);
  }

  return {
    answers,
    correctionRevision: corrections.reduce((max, c) => Math.max(max, c.revision), 0),
    correctedQuestions,
  };
}
