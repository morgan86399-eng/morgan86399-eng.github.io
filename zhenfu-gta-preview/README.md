# 鎮撫街 46 號｜實景 + 程序樓預覽

靜態頁面，給 [GitHub Pages](https://morgan86399-eng.github.io/zhenfu-gta-preview/) 使用。鏡頭對準桃園市桃園區鎮撫街 46 號附近約 200 公尺。

這不是台北 GTA 那套遊戲引擎，也不是實景街廓還原。官方 3D Tiles 負責既有樓體與道路；OpenStreetMap 有輪廓的基地才另鋪一層程序化招牌樓（店屋、公寓、中層、廟宇、公共）。

## 原點

- 經度 `121.3146923`
- 緯度 `24.9979870`
- 程序化樓底面：橢球高約 **89.9 公尺**（對齊鄰近官方建物模型的地面，不是逐棟地形）

## 資料

| 圖層 | 來源 | 怎麼用 |
| --- | --- | --- |
| 建物 | [國土測繪中心 3D Tiles 桃園市分棟](https://3dtiles.nlsc.gov.tw/building/tiles3d/37/tileset.json) | 瀏覽器即時串流，不進專案 |
| 道路 | [國土測繪中心道路 Tiles](https://3dtiles.nlsc.gov.tw/road/tiles3d/7/tileset.json) | 同上 |
| 底圖 | 國土測繪中心電子地圖 WMTS（EMAP） | 不用 OSM 圖磚（避免 403） |
| 程序化輪廓 | OpenStreetMap，ODbL | `data/buildings.json` 是 2026-09-29 的 Overpass 快照；頁面仍會試著向 Overpass 更新 |

畫面上可切「官方 3D Tiles／程序化招牌樓／兩者」。Cesium 使用 jsDelivr 上的 1.124，並設定 `CESIUM_BASE_URL`。場景持續繪製（`requestRenderMode: false`），避免 3D Tiles 還在載入時整面變黑。

## 本機開啟

在這個資料夾起一個靜態伺服器（不要用 `file://`，Cesium 與輪廓檔需要 HTTP）：

```bash
python3 -m http.server 8765
```

然後打開 <http://127.0.0.1:8765/>。

## 已知限制

- 這附近 OSM 建物輪廓大約二十多棟，多數房屋只有官方模型。
- 沒有樓層標籤的高度是類型示意，不是測量。
- 招牌是色塊，不是真實店名。
- 官方服務慢或中斷時，底圖與程序化樓仍可看；狀態列會寫明哪一層失敗。
