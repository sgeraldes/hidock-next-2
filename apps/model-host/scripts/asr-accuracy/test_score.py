import unittest
from score import edits, text_scores, cpwer, der, score


class Scores(unittest.TestCase):
    def test_known_substitution_deletion_insertion(self):
        self.assertEqual(edits('a b c'.split(), 'a x c d'.split()),
                         dict(substitutions=1, deletions=0, insertions=1, errors=2, referenceUnits=3, rate=2/3))
        self.assertEqual(edits(['a', 'b'], [])['deletions'], 2)
        self.assertIsNone(edits([], ['noise'])['rate'])
        self.assertEqual(edits([], ['noise'])['insertions'], 1)

    def test_normalization_preserves_spanish_accents_and_numbers(self):
        self.assertEqual(text_scores('¡Sí, café!', 'sí café', 'normalized')['wer']['errors'], 0)
        self.assertGreater(text_scores('Sí, café!', 'sí cafe', 'strict')['cer']['errors'], 0)
        self.assertEqual(text_scores('sí 2', 'si dos', 'normalized')['wer']['errors'], 2)
        self.assertEqual(text_scores('cafe\u0301', 'café', 'strict')['cer']['errors'], 0)

    def test_speaker_permutation_and_extra_speaker(self):
        ref = [{'speaker': 'A', 'text': 'uno dos'}, {'speaker': 'B', 'text': 'tres'}]
        hyp = [{'speaker': 'Y', 'text': 'uno dos'}, {'speaker': 'X', 'text': 'tres'}]
        self.assertEqual(cpwer(ref, hyp, 'normalized')['rate'], 0)
        hyp.append({'speaker': 'Z', 'text': 'extra'})
        self.assertEqual(cpwer(ref, hyp, 'normalized')['insertions'], 1)
        hyp[0]['speaker'] = 'Unknown speaker'
        with self.assertRaises(ValueError): cpwer(ref, hyp, 'normalized')

    def test_der_permutation_overlap_miss_and_false_alarm(self):
        ref = [{'speaker': 'A', 'start': 0, 'end': 2}, {'speaker': 'B', 'start': 1, 'end': 2}]
        hyp = [{'speaker': 'X', 'start': 0, 'end': 1}, {'speaker': 'Y', 'start': 1, 'end': 2},
               {'speaker': 'X', 'start': 2, 'end': 3}]
        result = der(ref, hyp, 3)
        self.assertEqual(result['referenceSpeakerSeconds'], 3)
        self.assertEqual(result['missSeconds'], 1)
        self.assertEqual(result['falseAlarmSeconds'], 1)
        self.assertEqual(result['confusionSeconds'], 0)
        self.assertAlmostEqual(result['rate'], 2/3)

    def test_der_one_global_mapping_cannot_hide_identity_switch(self):
        ref = [{'speaker': 'A', 'start': 0, 'end': 1}, {'speaker': 'B', 'start': 1, 'end': 2}]
        hyp = [{'speaker': 'X', 'start': 0, 'end': 2}]
        self.assertEqual(der(ref, hyp, 2)['confusionSeconds'], 1)

    def fixture(self):
        return {'purpose': 'smoke', 'provenance': {'referenceKind': 'human', 'source': 'reviewer'},
                'items': [{'id': 'one', 'audioSha256': 'a'*64, 'text': 'uno dos tres'},
                          {'id': 'two', 'audioSha256': 'b'*64, 'text': 'cuatro'}]}

    def test_missing_outputs_are_deletions_not_omitted_from_average(self):
        result = score(self.fixture(), {'model': 'test', 'items': [{'id': 'one', 'audioSha256': 'a'*64, 'text': 'uno dos tres'}]})
        self.assertEqual(result['aggregate']['normalized']['wer']['rate'], 0.25)
        self.assertEqual(result['failedOrMissing'], 1)
        self.assertFalse(result['selectionEligible'])

    def test_selection_requires_explicit_policy_and_independent_provenance(self):
        ref = self.fixture()
        hyp = {'model': 'test', 'items': [dict(r) for r in ref['items']]}
        self.assertFalse(score(ref, hyp)['selectionEligible'])
        ref.update(purpose='selection', selectionPolicy={'minItems': 2, 'minReferenceWords': 4})
        ref['provenance']['heldOut'] = True
        self.assertTrue(score(ref, hyp)['selectionEligible'])
        ref['provenance']['referenceKind'] = 'model-output'
        with self.assertRaises(ValueError): score(ref, hyp)

    def test_hash_mismatch_cannot_compare_different_audio(self):
        with self.assertRaises(ValueError): score(self.fixture(), {'items': [{'id': 'one', 'audioSha256': 'x'*64, 'text': 'uno'}]})


if __name__ == '__main__': unittest.main()
