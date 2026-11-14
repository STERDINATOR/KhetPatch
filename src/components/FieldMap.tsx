import React, { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import {
  APILoadingStatus,
  APIProvider,
  AdvancedMarker,
  InfoWindow,
  Map as GoogleMap,
  Pin,
  useAdvancedMarkerRef,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';

declare const __KHETPATCH_MAPS_API_KEY__: string | undefined;

interface FieldMapProps {
  centerLat: number;
  centerLon: number;
  polygonGeoJson?: string | null;
  mode?: 'view' | 'pick_point' | 'draw_polygon';
  drawnPoints?: Array<[number, number]>; // [lon, lat]
  onPickPoint?: (lat: number, lon: number) => void;
  onAddPolygonVertex?: (lon: number, lat: number) => void;
  heightClass?: string;
}

function parsePolygonRing(polygonGeoJson?: string | null): Array<{ lat: number; lng: number }> {
  if (!polygonGeoJson) return [];
  try {
    const parsed = JSON.parse(polygonGeoJson) as { coordinates?: Array<Array<[number, number]>> };
    const ring = parsed?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 3) return [];
    return ring.map(([lon, lat]) => ({ lat, lng: lon }));
  } catch {
    return [];
  }
}

function GoogleVectorOverlays({
  polygonGeoJson,
  drawnPoints,
}: {
  polygonGeoJson?: string | null;
  drawnPoints: Array<[number, number]>;
}) {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');

  useEffect(() => {
    if (!map || !mapsLib) return;

    const cleanups: Array<() => void> = [];

    const savedPath = parsePolygonRing(polygonGeoJson);
    if (savedPath.length >= 3) {
      const savedPolygon = new mapsLib.Polygon({
        paths: savedPath,
        strokeColor: '#27D7ED',
        strokeOpacity: 0.95,
        strokeWeight: 2.5,
        fillColor: '#A7F33C',
        fillOpacity: 0.25,
        clickable: false,
        map,
      });
      cleanups.push(() => savedPolygon.setMap(null));
    }

    if (drawnPoints.length >= 3) {
      const drawnPath = drawnPoints.map(([lon, lat]) => ({ lat, lng: lon }));
      const draftPolygon = new mapsLib.Polygon({
        paths: drawnPath,
        strokeColor: '#A7F33C',
        strokeOpacity: 0.95,
        strokeWeight: 2.5,
        fillColor: '#A7F33C',
        fillOpacity: 0.2,
        clickable: false,
        map,
      });
      cleanups.push(() => draftPolygon.setMap(null));
    } else if (drawnPoints.length === 2) {
      const drawnPath = drawnPoints.map(([lon, lat]) => ({ lat, lng: lon }));
      const draftLine = new mapsLib.Polyline({
        path: drawnPath,
        strokeColor: '#A7F33C',
        strokeOpacity: 0.95,
        strokeWeight: 2.5,
        clickable: false,
        map,
      });
      cleanups.push(() => draftLine.setMap(null));
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [map, mapsLib, polygonGeoJson, drawnPoints]);

  return null;
}

function GoogleMapInner({
  centerLat,
  centerLon,
  polygonGeoJson,
  mode,
  drawnPoints,
  basemap,
  onPickPoint,
  onAddPolygonVertex,
  onAuthFallback,
}: {
  centerLat: number;
  centerLon: number;
  polygonGeoJson?: string | null;
  mode: 'view' | 'pick_point' | 'draw_polygon';
  drawnPoints: Array<[number, number]>;
  basemap: 'satellite' | 'street';
  onPickPoint?: (lat: number, lon: number) => void;
  onAddPolygonVertex?: (lon: number, lat: number) => void;
  onAuthFallback: () => void;
}) {
  const status = useApiLoadingStatus();
  const [markerRef, marker] = useAdvancedMarkerRef();
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    if (status === APILoadingStatus.AUTH_FAILURE) {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
      onAuthFallback();
    }
  }, [status, onAuthFallback]);

  const handleClick = useCallback(
    (ev: { detail?: { latLng?: { lat: number; lng: number } | null } }) => {
      const latLng = ev?.detail?.latLng;
      if (!latLng) return;
      const lat = Number(latLng.lat.toFixed(6));
      const lon = Number(latLng.lng.toFixed(6));
      if (mode === 'pick_point' && onPickPoint) {
        onPickPoint(lat, lon);
      } else if (mode === 'draw_polygon' && onAddPolygonVertex) {
        onAddPolygonVertex(lon, lat);
      }
    },
    [mode, onPickPoint, onAddPolygonVertex]
  );

  return (
    <GoogleMap
      mapId="DEMO_MAP_ID"
      internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
      center={{ lat: centerLat, lng: centerLon }}
      defaultZoom={15}
      mapTypeId={basemap === 'satellite' ? 'hybrid' : 'roadmap'}
      gestureHandling="greedy"
      mapTypeControl={false}
      streetViewControl={false}
      fullscreenControl={false}
      onClick={handleClick}
      style={{ width: '100%', height: '100%' }}
    >
      <AdvancedMarker
        ref={markerRef}
        position={{ lat: centerLat, lng: centerLon }}
        title={`Location: ${centerLat.toFixed(4)}, ${centerLon.toFixed(4)}`}
        onClick={() => setInfoOpen((prev) => !prev)}
      >
        <Pin background="#A7F33C" borderColor="#03152B" glyphColor="#03152B" />
      </AdvancedMarker>

      {infoOpen && marker && (
        <InfoWindow anchor={marker} maxWidth={220} onCloseClick={() => setInfoOpen(false)}>
          <div className="text-xs text-[#10251D] space-y-0.5">
            <div className="font-bold">KhetPatch Field Pin</div>
            <div className="font-mono-tabular">
              {centerLat.toFixed(5)}, {centerLon.toFixed(5)}
            </div>
          </div>
        </InfoWindow>
      )}

      {drawnPoints.map(([lon, lat], idx) => (
        <AdvancedMarker
          key={`vertex-${idx}-${lat}-${lon}`}
          position={{ lat, lng: lon }}
          title={`Vertex ${idx + 1}`}
        >
          <div className="w-3.5 h-3.5 rounded-full bg-[#27D7ED] border-2 border-white shadow" />
        </AdvancedMarker>
      ))}

      <GoogleVectorOverlays polygonGeoJson={polygonGeoJson} drawnPoints={drawnPoints} />
    </GoogleMap>
  );
}

function LeafletFallbackMap({
  centerLat,
  centerLon,
  polygonGeoJson,
  mode,
  drawnPoints,
  basemap,
  gibsOverlay,
  onPickPoint,
  onAddPolygonVertex,
  heightClass,
}: FieldMapProps & { basemap: 'satellite' | 'street'; gibsOverlay: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const gibsLayerRef = useRef<L.TileLayer | null>(null);

  const onPickPointRef = useRef(onPickPoint);
  const onAddPolygonVertexRef = useRef(onAddPolygonVertex);
  const modeRef = useRef(mode);

  onPickPointRef.current = onPickPoint;
  onAddPolygonVertexRef.current = onAddPolygonVertex;
  modeRef.current = mode;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [centerLat, centerLon],
      zoom: 15,
      zoomControl: true,
    });

    const layerGroup = L.layerGroup().addTo(map);
    mapRef.current = map;
    layerGroupRef.current = layerGroup;

    map.on('click', (e: L.LeafletMouseEvent) => {
      const lat = Number(e.latlng.lat.toFixed(6));
      const lon = Number(e.latlng.lng.toFixed(6));
      if (modeRef.current === 'pick_point' && onPickPointRef.current) {
        onPickPointRef.current(lat, lon);
      } else if (modeRef.current === 'draw_polygon' && onAddPolygonVertexRef.current) {
        onAddPolygonVertexRef.current(lon, lat);
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
      layerGroupRef.current = null;
      tileLayerRef.current = null;
      gibsLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }

    const url =
      basemap === 'satellite'
        ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    const attr =
      basemap === 'satellite'
        ? 'Tiles © Esri World Imagery'
        : '© OpenStreetMap contributors';

    tileLayerRef.current = L.tileLayer(url, { attribution: attr, maxZoom: 19 }).addTo(map);
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (gibsLayerRef.current) {
      map.removeLayer(gibsLayerRef.current);
      gibsLayerRef.current = null;
    }
    if (gibsOverlay) {
      const gibsDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      gibsLayerRef.current = L.tileLayer(
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${gibsDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
        {
          attribution: 'Visual imagery © NASA GIBS',
          maxNativeZoom: 9,
          maxZoom: 19,
          opacity: 0.6,
        }
      ).addTo(map);
    }
  }, [gibsOverlay]);

  useEffect(() => {
    const map = mapRef.current;
    const lg = layerGroupRef.current;
    if (!map || !lg) return;

    lg.clearLayers();

    L.circleMarker([centerLat, centerLon], {
      radius: 7,
      color: '#03152B',
      weight: 2,
      fillColor: '#A7F33C',
      fillOpacity: 1,
    })
      .bindTooltip(`Location: ${centerLat.toFixed(4)}, ${centerLon.toFixed(4)}`)
      .addTo(lg);

    if (polygonGeoJson) {
      try {
        const parsed = JSON.parse(polygonGeoJson) as { coordinates?: Array<Array<[number, number]>> };
        const ring = parsed?.coordinates?.[0];
        if (Array.isArray(ring) && ring.length >= 3) {
          const latLngs = ring.map(([lon, lat]) => [lat, lon] as [number, number]);
          L.polygon(latLngs, {
            color: '#27D7ED',
            weight: 2.5,
            fillColor: '#A7F33C',
            fillOpacity: 0.25,
          }).addTo(lg);
        }
      } catch {
        // ignore invalid geojson
      }
    }

    if ((drawnPoints || []).length > 0) {
      const latLngs = (drawnPoints || []).map(([lon, lat]) => [lat, lon] as [number, number]);
      latLngs.forEach((pt, idx) => {
        L.circleMarker(pt, {
          radius: 5,
          color: '#FFFFFF',
          weight: 2,
          fillColor: '#27D7ED',
          fillOpacity: 1,
        })
          .bindTooltip(`Vertex ${idx + 1}`)
          .addTo(lg);
      });
      if (latLngs.length >= 3) {
        L.polygon(latLngs, {
          color: '#A7F33C',
          weight: 2.5,
          dashArray: '5,5',
          fillColor: '#A7F33C',
          fillOpacity: 0.2,
        }).addTo(lg);
      } else if (latLngs.length === 2) {
        L.polyline(latLngs, { color: '#A7F33C', weight: 2.5 }).addTo(lg);
      }
    }

    map.setView([centerLat, centerLon], map.getZoom(), { animate: true });
  }, [centerLat, centerLon, polygonGeoJson, drawnPoints]);

  return <div ref={containerRef} className={`w-full ${heightClass}`} data-testid="field-map-fallback" />;
}

export function FieldMap({
  centerLat,
  centerLon,
  polygonGeoJson,
  mode = 'view',
  drawnPoints = [],
  onPickPoint,
  onAddPolygonVertex,
  heightClass = 'h-72',
}: FieldMapProps) {
  const [basemap, setBasemap] = useState<'satellite' | 'street'>('satellite');
  const [gibsOverlay, setGibsOverlay] = useState(false);
  const [authFallback, setAuthFallback] = useState(false);

  const initialEnvKey =
    (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ||
    (typeof __KHETPATCH_MAPS_API_KEY__ !== 'undefined' ? __KHETPATCH_MAPS_API_KEY__ : '') ||
    '';

  const [apiKey, setApiKey] = useState<string>(initialEnvKey);

  useEffect(() => {
    if (apiKey) return;
    fetch('/api/v1/public/maps-config')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { apiKey?: string } | null) => {
        if (data?.apiKey) setApiKey(data.apiKey);
      })
      .catch(() => {});
  }, [apiKey]);

  const useGoogleMaps = Boolean(apiKey) && !authFallback;

  return (
    <div className="space-y-1.5">
      <div className="relative rounded-xl overflow-hidden border border-[#DCE8DC] bg-[#071E38]">
        <div className="absolute top-2.5 right-2.5 z-[400] flex items-center gap-1 bg-[#03152B]/85 backdrop-blur-sm p-1 rounded-lg border border-white/15">
          <button
            type="button"
            onClick={() => setBasemap('satellite')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              basemap === 'satellite' ? 'bg-[#A7F33C] text-[#03152B]' : 'text-slate-200 hover:bg-white/10'
            }`}
          >
            Satellite
          </button>
          <button
            type="button"
            onClick={() => setBasemap('street')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
              basemap === 'street' ? 'bg-[#A7F33C] text-[#03152B]' : 'text-slate-200 hover:bg-white/10'
            }`}
          >
            Street
          </button>
          {!useGoogleMaps && (
            <button
              type="button"
              onClick={() => setGibsOverlay((prev) => !prev)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                gibsOverlay ? 'bg-[#27D7ED] text-[#03152B]' : 'text-slate-200 hover:bg-white/10'
              }`}
            >
              NASA GIBS
            </button>
          )}
        </div>

        {useGoogleMaps ? (
          <div className={`w-full ${heightClass}`} data-testid="google-field-map">
            <APIProvider apiKey={apiKey} language="en" region="IN">
              <GoogleMapInner
                centerLat={centerLat}
                centerLon={centerLon}
                polygonGeoJson={polygonGeoJson}
                mode={mode}
                drawnPoints={drawnPoints}
                basemap={basemap}
                onPickPoint={onPickPoint}
                onAddPolygonVertex={onAddPolygonVertex}
                onAuthFallback={() => setAuthFallback(true)}
              />
            </APIProvider>
          </div>
        ) : (
          <LeafletFallbackMap
            centerLat={centerLat}
            centerLon={centerLon}
            polygonGeoJson={polygonGeoJson}
            mode={mode}
            drawnPoints={drawnPoints}
            basemap={basemap}
            gibsOverlay={gibsOverlay}
            onPickPoint={onPickPoint}
            onAddPolygonVertex={onAddPolygonVertex}
            heightClass={heightClass}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#52635C]">
        <span>
          {useGoogleMaps
            ? 'Google Maps Platform (WGS84 / EPSG:4326)'
            : gibsOverlay
            ? 'NASA GIBS MODIS visual imagery layer active (visual context only — numeric calculations use NASA POWER / CMR / Open-Meteo).'
            : 'WGS84 / EPSG:4326 · Visual map imagery is separate from numeric satellite/weather data.'}
        </span>
      </div>
    </div>
  );
}
