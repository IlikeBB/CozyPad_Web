# Synthetic Ablation Log

## Experiment Group

project: fake-medical-slices-v1
base model: ConvNeXt-T
metric: validation AUC
goal: identify useful training tricks

| run | balanced sampler | mixup | cutmix | label smoothing | val auc | val f1 | comment |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| ablate-0001 | no | no | no | no | 0.812 | 0.631 | baseline underfits class_2 |
| ablate-0002 | yes | no | no | no | 0.846 | 0.682 | recall improved |
| ablate-0003 | yes | 0.2 | no | no | 0.862 | 0.704 | best improvement from mixup |
| ablate-0004 | yes | 0.2 | 0.1 | no | 0.871 | 0.721 | best overall |
| ablate-0005 | yes | 0.4 | 0.1 | no | 0.855 | 0.699 | too much mixup |
| ablate-0006 | yes | 0.2 | 0.1 | 0.05 | 0.868 | 0.714 | smoothing did not help |

## Observations

1. Balanced sampler gave the largest recall improvement for class_2.
2. Mixup 0.2 helped generalization.
3. CutMix 0.1 added a small gain.
4. Label smoothing did not improve the main metric.
5. Mixup 0.4 reduced F1, likely too aggressive for small dataset.

## Decision

Keep balanced sampler, mixup=0.2, cutmix=0.1.
Remove label smoothing from the next training sweep.
