# memes

将本地表情包按分类放到子目录中，例如：

- `memes/laugh`
- `memes/question`

`MemeInterceptor` 会把 AI 返回中的标签 `[[表情: 类别名]]` 替换为 OneBot v11 图片 CQ 码。

当前默认映射：

- `嘲笑` -> `laugh`
- `疑问` -> `question`

支持图片格式：`.jpg`、`.jpeg`、`.png`、`.gif`。
