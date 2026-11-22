# 零件库存对照

把嘉立创导出的 BOM 和手头库存对一下。

- Comment、Footprint、Value 有一项对不上，就是没有这颗料。
- 这三项都对上、只有 Manufacturer Part 不同，用橙色标出，并显示入库备注和厂家型号。
- 没有的料可以忽略。导出时会跳过已忽略的行，生成一份新的 BOM 表格。
- 可以手动入库，备注会记在这颗料上。

库存数据在本机 `data/inventory.db`，不会提交到仓库。

## 运行

需要 Node.js 22 或更新版本。

```bash
npm install
npm start
```

Windows 上也可以双击 `启动库存对照.bat`，会打开一个独立窗口。

第一次导入嘉立创 BOM 作为初始库存时，可以把表格路径放到环境变量 `STOCK_SEED`。

## 许可

MIT
