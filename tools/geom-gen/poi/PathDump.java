/*
 * Prints the paths Apache POI 5.2.5 builds for presets and for single arcs, the reference of
 * packages/renderer/src/geom/path.test.ts ("POI paths"). Not part of any build: run it by hand when a reference
 * path is in doubt (see tools/geom-gen/README.md).
 *
 * Input, one case per line on stdin:
 *   preset NAME W H [adjName=value ...]                  a preset at a W x H box
 *   arc W H PW PH X0 Y0 WR HR ST SW [WR HR ST SW ...]   moveTo X0 Y0, then arcTo each, in a path whose own
 *                                                        space is PW x PH (-1: the box), at a W x H box
 * Output, one JSON object per line:
 *   {"case": "...", "paths": [{"fill": "NORM", "stroke": true, "segs": [[type, coords...], ...]}],
 *    "rect": [l, t, r, b], "sites": [[ang, x, y], ...]}
 * with the segments of java.awt.geom.PathIterator (0 moveTo, 1 lineTo, 2 quadTo, 3 cubicTo, 4 close) in box
 * coordinates, unflattened.
 *
 * The box is used as given, in the caller's units, as ordo's path builder takes it (POI's DrawSimpleShape
 * converts points to EMU and back, which changes nothing for these presets: their formulas scale with the box).
 * Each path is built as DrawSimpleShape.computeOutlines builds it: its guides are evaluated at its own space
 * (PW x PH, else the box) and the result is scaled to the box.
 *
 * POI 5.2.5 does not know the built-ins wd12, hd10 and cd3 (GuideDump.java adds them the same way).
 */
package org.apache.poi.sl.draw.geom;

import java.awt.geom.AffineTransform;
import java.awt.geom.Path2D;
import java.awt.geom.PathIterator;
import java.awt.geom.Rectangle2D;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public final class PathDump {
    private static Guide guide(String name, String fmla) {
        Guide g = new Guide();
        g.setName(name);
        g.setFmla(fmla);
        return g;
    }

    private static AdjustPoint point(String x, String y) {
        AdjustPoint p = new AdjustPoint();
        p.setX(x);
        p.setY(y);
        return p;
    }

    private static String num(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return "null";
        return Double.toString(v);
    }

    private static void segments(StringBuilder out, Path2D.Double path, double sx, double sy) {
        PathIterator it = path.getPathIterator(AffineTransform.getScaleInstance(sx, sy));
        double[] c = new double[6];
        out.append('[');
        boolean first = true;
        for (; !it.isDone(); it.next()) {
            int type = it.currentSegment(c);
            int n = type == PathIterator.SEG_MOVETO || type == PathIterator.SEG_LINETO ? 2
                : type == PathIterator.SEG_QUADTO ? 4 : type == PathIterator.SEG_CUBICTO ? 6 : 0;
            if (!first) out.append(',');
            first = false;
            out.append('[').append(type);
            for (int i = 0; i < n; i++) out.append(',').append(num(c[i]));
            out.append(']');
        }
        out.append(']');
    }

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line; (line = in.readLine()) != null; ) {
            line = line.trim();
            if (line.isEmpty()) continue;
            String[] f = line.split("\\s+");
            CustomGeometry geom = new CustomGeometry();
            Map<String, String> adj = new HashMap<>();
            double bw, bh;
            if (f[0].equals("preset")) {
                CustomGeometry src = PresetGeometries.getInstance().get(f[1]);
                if (src == null) throw new IllegalArgumentException("no preset " + f[1]);
                bw = Double.parseDouble(f[2]);
                bh = Double.parseDouble(f[3]);
                for (int i = 4; i < f.length; i++) {
                    String[] kv = f[i].split("=", 2);
                    adj.put(kv[0], "val " + kv[1]);
                }
                src.adjusts.forEach(geom::addAdjustGuide);
                geom.addGeomGuide(guide("wd12", "*/ w 1 12"));
                geom.addGeomGuide(guide("hd10", "*/ h 1 10"));
                geom.addGeomGuide(guide("cd3", "val 7200000"));
                src.guides.forEach(geom::addGeomGuide);
                src.paths.forEach(geom::addPath);
                src.connections.forEach(geom::addConnectionSite);
                geom.textBounds = src.textBounds;
            } else if (f[0].equals("arc")) {
                bw = Double.parseDouble(f[1]);
                bh = Double.parseDouble(f[2]);
                Path p = new Path();
                p.setW(Long.parseLong(f[3]));
                p.setH(Long.parseLong(f[4]));
                MoveToCommand m = new MoveToCommand();
                m.setPt(point(f[5], f[6]));
                p.addCommand(m);
                for (int i = 7; i + 3 < f.length; i += 4) {
                    ArcToCommand a = new ArcToCommand();
                    a.setWR(f[i]);
                    a.setHR(f[i + 1]);
                    a.setStAng(f[i + 2]);
                    a.setSwAng(f[i + 3]);
                    p.addCommand(a);
                }
                geom.addPath(p);
            } else {
                throw new IllegalArgumentException("unknown case " + f[0]);
            }
            IAdjustableShape props = name -> adj.containsKey(name) ? guide(name, adj.get(name)) : null;

            StringBuilder out = new StringBuilder("{\"case\":\"").append(line).append("\",\"paths\":[");
            boolean first = true;
            for (PathIf p : geom) {
                double pw = p.getW() == -1 ? bw : p.getW();
                double ph = p.getH() == -1 ? bh : p.getH();
                double sx = p.getW() == -1 ? 1 : bw / pw;
                double sy = p.getH() == -1 ? 1 : bh / ph;
                Context ctx = new Context(geom, new Rectangle2D.Double(0, 0, pw, ph), props);
                if (!first) out.append(',');
                first = false;
                out.append("{\"fill\":\"").append(p.getFill()).append("\",\"stroke\":").append(p.isStroked());
                out.append(",\"segs\":");
                segments(out, p.getPath(ctx), sx, sy);
                out.append('}');
            }
            out.append(']');
            Context box = new Context(geom, new Rectangle2D.Double(0, 0, bw, bh), props);
            if (geom.textBounds != null) {
                // setTextBounds stores the rect as moveTo l t, lineTo r t, lineTo r b, ...
                Path2D.Double r = geom.textBounds.getPath(box);
                PathIterator it = r.getPathIterator(null);
                double[] c = new double[6];
                it.currentSegment(c);
                double l = c[0], t = c[1];
                it.next();
                it.next();
                it.currentSegment(c);
                out.append(",\"rect\":[").append(num(l)).append(',').append(num(t)).append(',');
                out.append(num(c[0])).append(',').append(num(c[1])).append(']');
            }
            out.append(",\"sites\":[");
            first = true;
            for (ConnectionSiteIf s : geom.connections) {
                if (!first) out.append(',');
                first = false;
                out.append('[').append(num(box.getValue(s.getAng()))).append(',');
                out.append(num(box.getValue(s.getPos().getX()))).append(',');
                out.append(num(box.getValue(s.getPos().getY()))).append(']');
            }
            System.out.println(out.append("]}"));
        }
    }
}
