# Synthetic Error Analysis

## Confusion Matrix

Rows are ground truth, columns are predictions.

| class | pred_0 | pred_1 | pred_2 | pred_3 |
| --- | ---: | ---: | ---: | ---: |
| class_0 | 184 | 13 | 9 | 4 |
| class_1 | 18 | 151 | 22 | 6 |
| class_2 | 31 | 39 | 88 | 17 |
| class_3 | 7 | 10 | 15 | 144 |

## Class Metrics

| class | precision | recall | f1 | support |
| --- | ---: | ---: | ---: | ---: |
| class_0 | 0.767 | 0.876 | 0.818 | 210 |
| class_1 | 0.709 | 0.766 | 0.736 | 197 |
| class_2 | 0.657 | 0.503 | 0.570 | 175 |
| class_3 | 0.842 | 0.818 | 0.830 | 176 |

## Error Notes

- class_2 is confused with class_0 and class_1.
- false negatives for class_2 are the main issue.
- many class_2 examples have low contrast and small lesion area.
- class_3 performs well because features are visually distinctive.

## Suggested Fixes

1. Add class-balanced sampler or focal loss.
2. Add contrast augmentation for class_2.
3. Inspect label quality for class_2.
4. Try crop strategy focused on lesion region.
5. Report macro F1, not only accuracy.
