/*
 * Prints the guide values Apache POI 5.2.5 computes for presets, the reference values of
 * packages/renderer/src/geom/eval.test.ts ("POI spot checks"). Not part of any build: run it by hand when a
 * reference value is in doubt (see tools/geom-gen/README.md).
 *
 * Input, one case per line on stdin: preset l t w h [adjName=value ...]
 * Output, one JSON object per line: {"case": "...", "values": {"name": value, ...}} with every adjust value and
 * guide after evaluation (a later definition of a name wins, as POI's Context keeps it).
 *
 * POI 5.2.5 does not know the built-ins wd12, hd10 and cd3, which four presets use (it throws); they are added
 * as leading guides, which POI's Context.getValue reads before its built-ins.
 */
package org.apache.poi.sl.draw.geom;

import java.awt.geom.Rectangle2D;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

public final class GuideDump {
    private static Guide guide(String name, String fmla) {
        Guide g = new Guide();
        g.setName(name);
        g.setFmla(fmla);
        return g;
    }

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line; (line = in.readLine()) != null; ) {
            line = line.trim();
            if (line.isEmpty()) continue;
            String[] f = line.split("\\s+");
            CustomGeometry src = PresetGeometries.getInstance().get(f[0]);
            if (src == null) throw new IllegalArgumentException("no preset " + f[0]);
            Rectangle2D box = new Rectangle2D.Double(Double.parseDouble(f[1]), Double.parseDouble(f[2]),
                Double.parseDouble(f[3]), Double.parseDouble(f[4]));
            Map<String, String> adj = new HashMap<>();
            for (int i = 5; i < f.length; i++) {
                String[] kv = f[i].split("=", 2);
                adj.put(kv[0], "val " + kv[1]);
            }
            CustomGeometry geom = new CustomGeometry();
            src.adjusts.forEach(geom::addAdjustGuide);
            geom.addGeomGuide(guide("wd12", "*/ w 1 12"));
            geom.addGeomGuide(guide("hd10", "*/ h 1 10"));
            geom.addGeomGuide(guide("cd3", "val 7200000"));
            src.guides.forEach(geom::addGeomGuide);
            Context ctx = new Context(geom, box, name -> adj.containsKey(name) ? guide(name, adj.get(name)) : null);
            Map<String, Double> values = new LinkedHashMap<>();
            for (GuideIf g : geom.adjusts) values.put(g.getName(), ctx.getValue(g.getName()));
            for (GuideIf g : src.guides) values.put(g.getName(), ctx.getValue(g.getName()));
            StringBuilder out = new StringBuilder("{\"case\":\"").append(line).append("\",\"values\":{");
            boolean first = true;
            for (Map.Entry<String, Double> e : values.entrySet()) {
                if (!first) out.append(',');
                first = false;
                out.append('"').append(e.getKey()).append("\":").append(e.getValue());
            }
            System.out.println(out.append("}}"));
        }
    }
}
