# Synthetic Model Scoreboard

這是假的模型分數表，用於測試 Markdown 彙整是否能整理排名、優缺點與推薦模型。

| run | model | seed | val acc | val f1 | val auc | test acc | test f1 | test auc | latency ms | params |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| resnet50-1042 | ResNet50 | 1042 | 0.637 | 0.618 | 0.801 | 0.621 | 0.604 | 0.789 | 7.8 | 25.6M |
| swin-2048 | Swin-T | 2048 | 0.733 | 0.716 | 0.866 | 0.719 | 0.702 | 0.852 | 18.4 | 28.3M |
| efficientnet-4096 | EfficientNet-B3 | 4096 | 0.701 | 0.682 | 0.842 | 0.688 | 0.671 | 0.829 | 11.2 | 12.0M |
| convnext-1337 | ConvNeXt-T | 1337 | 0.742 | 0.721 | 0.871 | 0.726 | 0.708 | 0.857 | 16.9 | 28.6M |
| vit-7777 | ViT-B/16 | 7777 | 0.715 | 0.691 | 0.848 | 0.676 | 0.648 | 0.811 | 24.5 | 86.6M |

## Quick Notes

- ConvNeXt-T has the best validation AUC and test AUC.
- Swin-T is close to ConvNeXt-T but slightly slower than EfficientNet-B3.
- ResNet50 is fastest but weaker on minority recall.
- ViT-B/16 overfits: validation metrics look acceptable, but test F1 drops.
- EfficientNet-B3 is a good balance if latency is important.

## Fake Recommendation

Use `convnext-1337` for accuracy-focused experiments.
Use `efficientnet-4096` for balanced deployment tests.
Use `resnet50-1042` as the fast baseline.
