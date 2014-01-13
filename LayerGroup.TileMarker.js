;(function(){

    /**
     * A Container for dynamically loading markers.
     * A hybrid of L.LayerTile behavior to manage which Markers to display and data to request.
     *
     * TODO - Create a data cache, so that we are not re-requesting the same data / tiles
     *
     */

    /**
     * TODO - Remove jQuery as a dependency.
     * @requires jQuery
     */

    L.LayerGroup.TileMarker = L.LayerGroup.extend({
        includes: L.Mixin.Events,

        /**
         * From TileLayer
         */
        options: {
            minZoom: 0,
            maxZoom: 18,
            tileSize: 256,
            subdomains: 'abc',
            errorTileUrl: '',
            attribution: '',
            zoomOffset: 0,
            opacity: 1,
            /* (undefined works too)
             zIndex: null,
             tms: false,
             continuousWorld: false,
             noWrap: false,
             zoomReverse: false,
             detectRetina: false,
             */
            unloadInvisibleTiles: true, //L.Browser.mobile,
            updateWhenIdle: L.Browser.mobile,

            /**
             * icon
             */
            icon : null
        },

        initialize : function(url, options) {
            L.LayerGroup.prototype.initialize.call(this); // initialize w/o layers, since we will request the points dynamically for the given bounds

            this._url = url;
            this._tileData = {}; // internal cache - TODO : verify this is memory safe when we have real points.

            // From L.TileLayer#initialize
            options = L.setOptions(this, options);

            // detecting retina displays, adjusting tileSize and zoom levels
            if (options.detectRetina && L.Browser.retina && options.maxZoom > 0) {

                options.tileSize = Math.floor(options.tileSize / 2);
                options.zoomOffset++;

                if (options.minZoom > 0) {
                    options.minZoom--;
                }
                this.options.maxZoom--;
            }
        },

        onAdd : function(map){
            L.LayerGroup.prototype.onAdd.apply(this, arguments);


            // From L.TileLayer
            // set up events
            map.on({
                'viewreset': this._resetCallback,
                'moveend': this._update
            }, this);

            if (!this.options.updateWhenIdle) {
                this._limitedUpdate = L.Util.limitExecByInterval(this._update, 150, this);
                map.on('move', this._limitedUpdate, this);
            }

            this._reset();
            this._update();
        },

        onRemove : function(map) {
            L.LayerGroup.prototype.onRemove.apply(this, arguments);

            // From L.TileLayer
            map.off({
                'viewreset': this._resetCallback,
                'moveend': this._update
            }, this);

            if (!this.options.updateWhenIdle) {
                map.off('move', this._limitedUpdate, this);
            }


            this._map = null;
        },

        addTo : function() {
            L.LayerGroup.prototype.addTo.apply(this, arguments);

            // request json for marker points
        },

        _resetCallback : function(e){
            this._reset();
        },


        _reset : function() {
            var tiles = this._tiles;

            for (var key in tiles) {
                if (tiles.hasOwnProperty(key)) {
                    this.fire('tileunload', {tile: tiles[key]});
                }
            }

            this._tiles = {};
            this._tilesToLoad = 0;

            this.clearLayers();
        },

        /**
         * Based on L.TileLayer#_update
         * @private
         */
        _update : function(){
            if (!this._map) { return; }

            var bounds = this._map.getPixelBounds(),
                zoom = this._map.getZoom(),
                tileSize = this.options.tileSize;

            if (zoom > this.options.maxZoom || zoom < this.options.minZoom) {
                return;
            }

            var nwTilePoint = new L.Point(
                    Math.floor(bounds.min.x / tileSize),
                    Math.floor(bounds.min.y / tileSize)),

                seTilePoint = new L.Point(
                    Math.floor(bounds.max.x / tileSize),
                    Math.floor(bounds.max.y / tileSize)),

                tileBounds = new L.Bounds(nwTilePoint, seTilePoint);

            this._addTilesFromCenterOut(tileBounds);

            if (this.options.unloadInvisibleTiles) {
                this._removeOtherTiles(tileBounds);
            }

        },

        /**
         * Just like L.TileLayer except a 'tile' DOM element is not created.
         * Our Tiles are virtual: collections of markers grouped by bounds.
         *
         * @param bounds
         * @private
         */
        _addTilesFromCenterOut: function (bounds) {
            var queue = [],
                center = bounds.getCenter();

            var j, i, point;

            for (j = bounds.min.y; j <= bounds.max.y; j++) {
                for (i = bounds.min.x; i <= bounds.max.x; i++) {
                    point = new L.Point(i, j);

                    if (this._tileShouldBeLoaded(point)) {
                        queue.push(point);
                    }
                }
            }

            var tilesToLoad = queue.length;

            if (tilesToLoad === 0) { return; }

            // load tiles in order of their distance to center
            queue.sort(function (a, b) {
                return a.distanceTo(center) - b.distanceTo(center);
            });


            // if its the first batch of tiles to load
            if (!this._tilesToLoad) {
                this.fire('loading');
            }

            this._tilesToLoad += tilesToLoad;

            for (i = 0; i < tilesToLoad; i++) {
                this._addTile(queue[i]);
            }
        },

        _removeOtherTiles: function (bounds) {
            var kArr, x, y, key;

            for (key in this._tiles) {
                if (this._tiles.hasOwnProperty(key)) {
                    kArr = key.split(':');
                    x = parseInt(kArr[0], 10);
                    y = parseInt(kArr[1], 10);

                    // remove tile if it's out of bounds
                    if (x < bounds.min.x || x > bounds.max.x || y < bounds.min.y || y > bounds.max.y) {
                        this._removeTile(key); // TODO this is broken in IE.  Null Tile.
                    }
                }
            }
        },

        _removeTile: function (key) {
            var self = this,
                tile = this._tiles[key];

            if (!tile){
                // Already removed or never added.
                // IE seems to be in some cases calling update handler duplicate times.
                return;
            }

            this.fire("tileunload", {tile: tile, url: tile.url});
            var markers = tile.markers || [];
            $.each(markers, function(i, marker){
                self.removeLayer(marker);
            });

            delete this._tiles[key];
        },

        _tileShouldBeLoaded: function (tilePoint) {
            if ((tilePoint.x + ':' + tilePoint.y) in this._tiles) {
                return false; // already loaded
            }

            // TODO - @see also map's cfg for jumpWorldCopy
            if (!this.options.continuousWorld) {
                var limit = this._getWrapTileNum();

                if (this.options.noWrap && (tilePoint.x < 0 || tilePoint.x >= limit) ||
                    tilePoint.y < 0 || tilePoint.y >= limit) {
                    return false; // exceeds world bounds
                }
            }

            return true;
        },

        _getWrapTileNum : function(){
            return L.TileLayer.prototype._getWrapTileNum.apply(this, arguments);
        },

        _getZoomForUrl: function(){
            return L.TileLayer.prototype._getZoomForUrl.apply(this, arguments);
        },

        _getTilePos: function (tilePoint) {
            return L.TileLayer.prototype._getTilePos.apply(this, arguments);
        },

        _adjustTilePoint : function(){
            return L.TileLayer.prototype._adjustTilePoint.apply(this, arguments);
        },

        _getSubdomain : function(){
            return L.TileLayer.prototype._getSubdomain.apply(this, arguments);
        },

        _addTile: function (tilePoint) {
//            var tilePos = this._getTilePos(tilePoint);
            var tile = {
                tilePoint : tilePoint
            }; // markers - for easily removing when the virtual tile is removed
            var key = tilePoint.x + ':' + tilePoint.y;

            this._tiles[key] = tile;
            tile.key = key;

            this._loadTile(tile);
        },

        _getTileBoundsForPoint : function(tilePoint) {
            var options = this.options,
                tileSize = options.tileSize;

            var nwPoint = tilePoint.multiplyBy(tileSize);
            var sePoint = nwPoint.add(new L.Point(tileSize, tileSize));

            // optionally, enlarge request area.
            // with this I can draw points with coords outside this tile area,
            // but with part of the graphics actually inside this tile.
            // NOTE: that you should use this option only if you're actually drawing points!
            var buf = this.options.buffer;
            if (buf > 0) {
                var diff = new L.Point(buf, buf);
                nwPoint = nwPoint.subtract(diff);
                sePoint = sePoint.add(diff);
            }

            var zoom = this._map.getZoom();

            var nwCoord = this._map.unproject(nwPoint, zoom, true);
            var seCoord = this._map.unproject(sePoint, zoom, true);
            var bounds = [nwCoord.lng, seCoord.lat, seCoord.lng, nwCoord.lat];


            return bounds;
        },

        /**
         * Override
         * @param tile
         * @returns {*}
         */
        getTileUrl: function (tile) {

            this._adjustTilePoint(tile.tilePoint); // mutator

            // This tile's bounds
            var bounds = this._getTileBoundsForPoint(tile.tilePoint);
            tile.bounds = bounds;


            // Convert to sw, ne
            var neLatLng = new L.LatLng(bounds[3], bounds[2]);
            var swLatLng = new L.LatLng(bounds[1], bounds[0]);
            tile.latLngBounds = new L.LatLngBounds(swLatLng, neLatLng);


            var zoom = this._getZoomForUrl();


            // URL Format '/markers/assets.json?sw={swLng},{swLat}&ne={neLng},{neLat}&zoom={z}'
            return L.Util.template(this._url, L.extend({
                neLat : neLatLng.lat,
                neLng : neLatLng.lng,
                swLat : swLatLng.lat,
                swLng : swLatLng.lng,
                z : zoom
            }, this.options));

            // Url Format '/markers/{tlx}/{tly}/{brx}/{bry}'
//            return L.Util.template(this._url, L.extend({
//                tlx: bounds[0],
//                tly: bounds[1],
//                brx: bounds[2],
//                bry: bounds[3]
//            }, this.options));

            // Url Format '/markers/{z}/{x}/{y}'
//            return L.Util.template(this._url, L.extend({
//                s: this._getSubdomain(tilePoint),
//                z: this._getZoomForUrl(),
//                x: tilePoint.x,
//                y: tilePoint.y
//            }, this.options));
        },


        _loadTile: function (tile) {
            var self = this;
            var url = this.getTileUrl(tile);
            tile.url = url;
            var onSuccess = function(data) {
                self._tileData[url] = data;
                self._tileOnLoad(tile, data);
            };

            var onFailure = function(data) {
                self._tileOnError(tile, data);
            };

            var tileData = this._tileData[url];
            if (tileData) {
                onSuccess(tileData);
            } else {
                $.when($.getJSON(url))
                    .then(onSuccess, onFailure);
            }
        },

        _tileLoaded: function () {
            this._tilesToLoad--;
            if (!this._tilesToLoad) {
                this.fire('load');
            }
        },

        _isTileVisible : function(tile) {
            var mapBounds = this._map.getBounds();
            var paddedBounds = mapBounds.pad(.30);
            //var isVisible = tile.latLngBounds.intersects(paddedBounds);


            return tile.latLngBounds.intersects(mapBounds);
        },

        _tileOnLoad: function (tile, geoJSON) {
            var self = this;
            tile.geoJSON = geoJSON;

            if (!this._isTileVisible(tile)){
                var tileKey = tile.key;
                self._removeTile(tileKey);

                return;
            }


            var markers = tile.markers = this._createMarkers(geoJSON);
            $.each(markers, function(i, marker){
                self.addLayer(marker);
            });

            this.fire('tileload', {
                tile: tile
            });

            this._tileLoaded();
        },

        _createMarkers : function(geoJSON) {
            if (!geoJSON) {
                return;
            }

            var getLatlng = function(feature) {
                if (!feature.geometry || feature.geometry.type !== 'Point') {
                    return false;
                }

                var coords = feature.geometry.coordinates;
                latlng = L.GeoJSON.coordsToLatLng(coords);


                return latlng;
            };

            var icon = this.options.icon;
            var markers = [],
                features = geoJSON.features || [];

            for (var i = 0, n = features.length; i<n; i++) {
                var feature = features[i];
                var latlng = getLatlng(feature);

                var options = (!!icon) ? {
                    icon : icon
                } : null;
                var marker = new L.Marker(latlng, options);
                markers.push(marker);
            }


            return markers;
        },

        _tileOnError: function (tile, data) {

            this.fire('tileerror', {
                tile: tile
            });

            // TODO should we handle with '?' display for the tile ??
            this._tileLoaded();
        }


    });
})();