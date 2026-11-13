#!/usr/bin/env python3
"""
Build verified corpus manifest input.
"""

import json
import urllib.request
import re

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def get_html(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode('utf-8', errors='ignore')

def main():
    items = []

    # 1. Lakeland Hills sermons
    print("Scraping Lakeland Hills sermons...")
    html_lh_sermons = get_html('https://lakelandhillschurchofchrist.com/sermons/')
    lh_sermon_urls = list(dict.fromkeys(re.findall(r'href=[\"\'](https://lakelandhillschurchofchrist\.com/wp-content/uploads/[^\"\']+\.pptx)[\"\']', html_lh_sermons, re.I)))

    # Pick 18 diverse sermons
    selected_lh_sermons = lh_sermon_urls[:18]
    for url in selected_lh_sermons:
        fname = url.split('/')[-1]
        clean_name = re.sub(r'[^a-zA-Z0-9_\-\.]', '_', fname)
        title = fname.replace('.pptx', '').replace('-', ' ').replace('_', ' ')
        items.append({
            "rel_path": f"church-sermons/lh_{clean_name}",
            "category": "church-sermons",
            "url": url,
            "description": f"Sunday Sermon: {title} (Lakeland Hills Church of Christ)"
        })

    # 2. Des Moines Church of Christ sermons
    print("Scraping Des Moines sermons...")
    html_dsm = get_html('https://dsmcoc.com/powerpoint-sermons/')
    dsm_urls = list(dict.fromkeys(re.findall(r'href=[\"\'](https://dsmcoc\.com/wp-content/uploads/[^\"\']+\.pptx)[\"\']', html_dsm, re.I)))

    # Pick 14 diverse sermons
    selected_dsm = dsm_urls[:14]
    for url in selected_dsm:
        fname = url.split('/')[-1]
        clean_name = re.sub(r'[^a-zA-Z0-9_\-\.]', '_', fname)
        title = fname.replace('.pptx', '').replace('-', ' ').replace('_', ' ')
        items.append({
            "rel_path": f"church-sermons/dsm_{clean_name}",
            "category": "church-sermons",
            "url": url,
            "description": f"Sunday Sermon: {title} (Des Moines Church of Christ)"
        })

    # 3. West 65th St Church of Christ sermons
    print("Scraping West 65th St sermons...")
    html_w65 = get_html('http://w65stchurchofchrist.com')
    w65_raw = list(dict.fromkeys(re.findall(r'href=[\"\']([^\"\']+\.pptx)[\"\']', html_w65, re.I)))
    w65_urls = [re.sub(r'^(https?://[^/]+)?/+', 'http://w65stchurchofchrist.com/', l) for l in w65_raw][:8]

    for url in w65_urls:
        fname = url.split('/')[-1]
        clean_name = re.sub(r'[^a-zA-Z0-9_\-\.]', '_', fname)
        title = fname.replace('.pptx', '').replace('-', ' ').replace('_', ' ')
        items.append({
            "rel_path": f"church-sermons/w65_{clean_name}",
            "category": "church-sermons",
            "url": url,
            "description": f"Sunday Sermon: {title} (West 65th St Church of Christ)"
        })

    # 4. Church Pre-Worship Lessons & Ministry Announcements
    print("Scraping Lakeland Hills pre-worship lessons...")
    html_lh_lessons = get_html('https://lakelandhillschurchofchrist.com/ppt-lessons/')
    lh_lesson_urls = list(dict.fromkeys(re.findall(r'href=[\"\'](https://lakelandhillschurchofchrist\.com/wp-content/uploads/[^\"\']+\.pptx)[\"\']', html_lh_lessons, re.I)))[:8]

    for url in lh_lesson_urls:
        fname = url.split('/')[-1]
        clean_name = re.sub(r'[^a-zA-Z0-9_\-\.]', '_', fname)
        title = fname.replace('.pptx', '').replace('-', ' ').replace('_', ' ')
        items.append({
            "rel_path": f"church-announcements-ministry/lh_lesson_{clean_name}",
            "category": "church-announcements-ministry",
            "url": url,
            "description": f"Pre-Worship Lesson / Study: {title} (Lakeland Hills Church of Christ)"
        })

    # Other Ministry & Church presentations
    items.extend([
        {
            "rel_path": "church-announcements-ministry/elca_2018_gathering_template.pptx",
            "category": "church-announcements-ministry",
            "url": "https://elcamediaresources.blob.core.windows.net/cdn/wp-content/uploads/2018Gathering_PowerpointTemplate.pptx",
            "description": "ELCA National Youth Gathering Presentation & Announcement Template"
        },
        {
            "rel_path": "church-announcements-ministry/fairpark_church_as_god_sees_it.pptx",
            "category": "church-announcements-ministry",
            "url": "https://www.fairparkchurchofchrist.com/uploads/1/1/9/6/11969954/the_church_as_god_sees_it_.pptx",
            "description": "Church Lesson: The Church as God Sees It (Fairpark Church of Christ)"
        },
        {
            "rel_path": "church-announcements-ministry/dsm_philippians_case_study_in_fellowship.pptx",
            "category": "church-announcements-ministry",
            "url": "https://dsmcoc.com/wp-content/uploads/2022/01/philippians-summary-case-study-in-fellowship.pptx",
            "description": "Church Study: Philippians Case Study in Christian Fellowship (Des Moines Church of Christ)"
        },
        {
            "rel_path": "church-announcements-ministry/twc_worship_announcements.pptx",
            "category": "church-announcements-ministry",
            "url": "https://raw.githubusercontent.com/eddy-lau/twc-worship-pptx/main/Presentation.pptx",
            "description": "Church Worship & Announcement Presentation (TWC Worship)"
        }
    ])

    # 5. Church Worship Lyrics, Hymns & Liturgy (18 decks)
    worship_decks = [
        # tin921/worship-pptx (bilingual Chinese/English Sunday worship services & hymns)
        {
            "rel_path": "church-worship-lyrics/worship_service_bilingual_full.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/tin921/worship-pptx/main/docs/tutorial/english-review/2026-10-25%20%E4%B8%BB%E6%97%A5%E6%95%AC%E6%8B%9C%20%E7%A4%BA%E7%AF%84.pptx",
            "description": "Full Sunday Worship Service: Call to worship, hymn lyrics, prayer, Scripture, responsive readings"
        },
        {
            "rel_path": "church-worship-lyrics/call_and_praise_lyrics_demo.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/tin921/worship-pptx/main/docs/tutorial/review-0.93.33/output/1025c-call%2Bpraise.pptx",
            "description": "Worship Lyrics: Call to worship & praise songs presentation"
        },
        {
            "rel_path": "church-worship-lyrics/call_and_praise_tutorial_deck.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/tin921/worship-pptx/main/docs/tutorial/review-0.93.33/output/TutorialDemo-1025c-call%2Bpraise.pptx",
            "description": "Worship Slide Deck: Praise set with background styling and hymn verses"
        },
        {
            "rel_path": "church-worship-lyrics/worship_praise_review_v34.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/tin921/worship-pptx/main/docs/tutorial/review-0.93.34/output/1025c-call%2Bpraise.pptx",
            "description": "Worship Song Presentation: Multi-verse praise song layout"
        },
        {
            "rel_path": "church-worship-lyrics/worship_praise_review_v35.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/tin921/worship-pptx/main/docs/tutorial/review-0.93.35/output/1025c-call%2Bpraise.pptx",
            "description": "Worship Song Deck: Congregational singing praise sequence"
        },
        {
            "rel_path": "church-worship-lyrics/worship_tutorial_demo_v35.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/tin921/worship-pptx/main/docs/tutorial/review-0.93.35/output/TutorialDemo-1025c-call%2Bpraise.pptx",
            "description": "Worship Presentation: Liturgical call and congregational singing set"
        },
        # danihrndzld/worshipdeck (Spanish Sunday worship services)
        {
            "rel_path": "church-worship-lyrics/spanish_sunday_worship_agosto.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/danihrndzld/worshipdeck/main/reference/decks/AGOSTO%2030.pptx",
            "description": "Sunday Service Worship Deck (Spanish): Himnos de alabanza, lecturas bíblicas, liturgia"
        },
        {
            "rel_path": "church-worship-lyrics/spanish_sunday_worship_septiembre.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/danihrndzld/worshipdeck/main/reference/decks/SEPTIEMBRE%206.pptx",
            "description": "Sunday Service Worship Deck (Spanish): Cantos, comunión, sermón y notas"
        },
        {
            "rel_path": "church-worship-lyrics/spanish_worship_style_template.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/danihrndzld/worshipdeck/main/reference/style-template.pptx",
            "description": "Worship Slide Style Template: High-contrast church projection layouts"
        },
        {
            "rel_path": "church-worship-lyrics/spanish_worship_example_template.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/danihrndzld/worshipdeck/main/reference/example-template.pptx",
            "description": "Worship Slide Example Template: Hymn structure with chorus and bridge markers"
        },
        # 8haol/selah (Worship lyrics with Pinyin ruby annotations)
        {
            "rel_path": "church-worship-lyrics/worship_lyrics_pinyin_ruby.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/8haol/selah/main/spikes/pptx-pinyin/evidence/selah-spike-sample.pptx",
            "description": "Bilingual Worship Lyrics: Chinese hymn text with per-character pinyin pronunciation layout"
        },
        {
            "rel_path": "church-worship-lyrics/worship_lyrics_themes_pinyin.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/8haol/selah/main/spikes/pptx-pinyin/evidence/selah-themes-sample.pptx",
            "description": "Worship Themes Sample: Pinyin worship lyric themes with multiple slide backgrounds"
        },
        # canal-dragon/H2P (Hymn-to-PowerPoint templates)
        {
            "rel_path": "church-worship-lyrics/hymn_dark_base_sans.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/canal-dragon/H2P/main/H2P-private-data/dark_base_sans.pptx",
            "description": "Hymnal Slide Theme: Dark background with clean sans-serif hymn stanza typography"
        },
        {
            "rel_path": "church-worship-lyrics/hymn_dark_base_serif.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/canal-dragon/H2P/main/H2P-private-data/dark_base_serif.pptx",
            "description": "Hymnal Slide Theme: Dark background with traditional serif hymn stanza typography"
        },
        {
            "rel_path": "church-worship-lyrics/hymn_light_base_standard.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/canal-dragon/H2P/main/H2P-private-data/light_base.pptx",
            "description": "Hymnal Slide Theme: Light background with high readability hymn text"
        },
        {
            "rel_path": "church-worship-lyrics/hymn_light_base_sans.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/canal-dragon/H2P/main/H2P-private-data/light_base_sans.pptx",
            "description": "Hymnal Slide Theme: Light background modern sans-serif lyric layout"
        },
        {
            "rel_path": "church-worship-lyrics/hymn_light_base_serif.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/canal-dragon/H2P/main/H2P-private-data/light_base_serif.pptx",
            "description": "Hymnal Slide Theme: Light background classic serif lyric layout"
        },
        # St Luke liturgical worship
        {
            "rel_path": "church-worship-lyrics/stluke_liturgical_worship_template.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/bevomac/stluke-worship-slides/main/template/template.pptx",
            "description": "Liturgical Church Worship Template: St. Luke order of worship with prayers and responses"
        },
        # wongsunday contemporary worship
        {
            "rel_path": "church-worship-lyrics/contemporary_worship_song_sample.pptx",
            "category": "church-worship-lyrics",
            "url": "https://raw.githubusercontent.com/wongsunday/church-worship-slides/master/templates/sample/%E5%9B%A0%E4%BD%A0%E5%A0%85%E6%8C%81_sample.pptx",
            "description": "Contemporary Worship Song Slide: 16:9 widescreen layout with stanza & chorus breakdown"
        }
    ]
    items.extend(worship_decks)

    # 6. Challenging Features & Obscure PPTX Capabilities (38 decks)
    challenging = [
        # Video & Media
        {
            "rel_path": "challenging-features/video/embedded_video_mp4.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/EmbeddedVideo.pptx",
            "description": "Video: Embedded MP4 video part (`ppt/media/media1.mp4`) with video playback controls and poster"
        },
        {
            "rel_path": "challenging-features/video/common_media_node_properties.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/O14ISOStrict/PowerPoint/%5BHC%5Dcmedianode-CommonMediaNodProperties.pptx",
            "description": "Media: Common media node timing and playback properties in PresentationML"
        },
        {
            "rel_path": "challenging-features/video/image_animated_gif.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Image_AnimatedGIF.pptx",
            "description": "Media: Slide with animated GIF graphic image part and playback handling"
        },

        # Audio
        {
            "rel_path": "challenging-features/audio/embedded_audio_mp3.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/EmbeddedAudio.pptx",
            "description": "Audio: Embedded MP3 audio file (`ppt/media/media1.mp3`) with slide audio playback icon"
        },
        {
            "rel_path": "challenging-features/audio/audio_cd_track_reference.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/O14ISOStrict/Graphics/audioCdModifiedAndReSaved.pptx",
            "description": "Audio: Audio CD track reference and modified audio rels"
        },

        # SmartArt
        {
            "rel_path": "challenging-features/smartart/smartart_diagram_classic.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/SmartArt.pptx",
            "description": "SmartArt: Classic DrawingML SmartArt with data1.xml, layout1.xml, quickStyle1.xml, colors1.xml, drawing1.xml"
        },
        {
            "rel_path": "challenging-features/smartart/smartart_orgchart_2d.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/SmartArt_OrgChart1.pptx",
            "description": "SmartArt: 2D Organizational Chart diagram hierarchy with nodes and connectors"
        },
        {
            "rel_path": "challenging-features/smartart/smartart_orgchart_3d.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/SmartArt_OrgChart1_3D.pptx",
            "description": "SmartArt: 3D Organizational Chart with perspective and shading on nodes"
        },
        {
            "rel_path": "challenging-features/smartart/smartart_orgchart_animated.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/SmartArt_OrgChart1%2BAnimation%20(Fly%20In%2C%20as%20one%20object).pptx",
            "description": "SmartArt: Organizational Chart with entrance Fly-In animation as a composite object"
        },
        {
            "rel_path": "challenging-features/smartart/smartart_orgchart_3d_level_animated.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/SmartArt_OrgChart1_3D%2BAnimation%20(Fly%20In%2C%20by%20level%20one%20by%20one).pptx",
            "description": "SmartArt: 3D Organizational Chart with level-by-level progressive Fly-In animations"
        },

        # 3D Shapes, Bevels & Advanced Effects
        {
            "rel_path": "challenging-features/3d-and-effects/autoshapes_3d_bevel_circle_shadow.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/AutoShapes_3D_Bevel%20(Circle)%2BShadow%20(Offset%2C%20Diagonal).pptx",
            "description": "3D Effects: Circle bevel material rendering with diagonal offset drop shadow"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/autoshapes_3d_bevel_circle_soft_edges.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/AutoShapes_3D_Bevel%20(Circle)%2BSoft%20Edges%20(5%20Point).pptx",
            "description": "3D Effects: Circle bevel with 5-point soft edge erosion blur"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/autoshapes_3d_rotation_isometric.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/AutoShapes_3D_Rotation_Parallel%20(Isometric%20Right%20Up).pptx",
            "description": "3D Effects: Parallel isometric 3D rotation (right up camera transform)"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/autoshapes_3d_bevel_riblet_reflection.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/AutoShapes_3D_Bevel%20(Riblet)%2BReflection%20(full).pptx",
            "description": "3D Effects: Riblet preset bevel profile with full specular reflection layer"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/autoshapes_2d_soft_edges_5pt.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/AutoShapes_2D_Soft%20Edges%20(5%20Point).pptx",
            "description": "Effects: 2D vector shapes with 5-point DrawingML soft-edge blur"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/autoshapes_2d_reflection_full.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/AutoShapes_2D_Reflection%20(full).pptx",
            "description": "Effects: 2D vector shapes with full gradient reflection"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/autoshapes_2d_shadow_offset.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/AutoShapes_2D_Shadow%20(Offset%2C%20Diagonal).pptx",
            "description": "Effects: 2D vector shapes with diagonal offset drop shadow"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/image_small_3d_rotation.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Image_Small%2B3D%20Rotation.pptx",
            "description": "Effects: Bitmap image with 3D scene camera rotation"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/artistic_effect_sample.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/ArtisticEffectSample.pptx",
            "description": "Effects: Picture with PowerPoint artistic effects filters"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/cropped_bitmap_image.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/54542_cropped_bitmap.pptx",
            "description": "Geometry: Cropped bitmap image with crop coordinates in source rect"
        },

        # 3D Text & WordArt
        {
            "rel_path": "challenging-features/3d-and-effects/text_3d_extrusion.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Text_withExtrusion_100chars.pptx",
            "description": "WordArt: 3D text extrusion with depth extrusion formatting"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/text_effects_glow_bevel.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Text_withEffects_100chars.pptx",
            "description": "Text Effects: Text runs with glow and outer shadow effects"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/text_shadow_offset.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Text_withShadow_100chars.pptx",
            "description": "Text Effects: Text runs with drop shadow"
        },
        {
            "rel_path": "challenging-features/3d-and-effects/text_extrusion_animated.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Text_withExtrusion_200chars%2BAnimation%20(Fly%20In%2C%20all%20at%20once).pptx",
            "description": "WordArt & Animation: 3D extruded text with Fly-In timing animation"
        },

        # Charts (2D & 3D)
        {
            "rel_path": "challenging-features/charts/chart_2d_basic.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Chart_2D.pptx",
            "description": "Charts: Standard 2D chart with series and category axes"
        },
        {
            "rel_path": "challenging-features/charts/chart_3d_column.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Chart_3D%20(Column).pptx",
            "description": "Charts: 3D Column chart with floor, side walls, and elevation"
        },
        {
            "rel_path": "challenging-features/charts/chart_3d_pie.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/O14ISOStrict/Graphics/3D%20Pie-O12-PPT-Charts.pptx",
            "description": "Charts: 3D Pie chart with slice extrusion"
        },
        {
            "rel_path": "challenging-features/charts/chart_2d_area.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/O14ISOStrict/Graphics/2D%20Area-O12-PPT-Charts.pptx",
            "description": "Charts: 2D Area chart with category fill areas"
        },
        {
            "rel_path": "challenging-features/charts/chart_props_axes.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/scanny/python-pptx/master/features/steps/test_files/cht-charts.pptx",
            "description": "Charts: Chart properties, titles, legends, and axes"
        },
        {
            "rel_path": "challenging-features/charts/chart_datalabels.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/scanny/python-pptx/master/features/steps/test_files/cht-datalabels.pptx",
            "description": "Charts: Custom data labels placement and formatting"
        },
        {
            "rel_path": "challenging-features/charts/chart_pie_automatic_layout.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/LibreOffice/core/master/chart2/qa/extras/data/pptx/PieChartWithAutomaticLayout_SizeAndPosition.pptx",
            "description": "Charts: Pie chart with automatic layout, size, and positioning"
        },
        {
            "rel_path": "challenging-features/charts/chart_funnel_libreoffice.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/LibreOffice/core/master/chart2/qa/extras/data/pptx/funnel-pp1.pptx",
            "description": "Charts: Funnel chart with multi-stage series bars"
        },

        # Ink
        {
            "rel_path": "challenging-features/custom-geometry/ink_handwriting_drawing.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/v2FxTestFiles/presentation/Ink2.pptx",
            "description": "Digital Ink: Freehand ink strokes drawing (`<p:ink>` / inkML trace data)"
        },

        # DrawingML & Tables
        {
            "rel_path": "challenging-features/custom-geometry/drawingml_fill_types.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/scanny/python-pptx/master/features/steps/test_files/dml-fill.pptx",
            "description": "DrawingML: Solid, gradient, pattern, and blip fill varieties"
        },
        {
            "rel_path": "challenging-features/custom-geometry/drawingml_line_styles.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/scanny/python-pptx/master/features/steps/test_files/dml-line.pptx",
            "description": "DrawingML: Line styles, dash patterns, compound lines, and cap types"
        },
        {
            "rel_path": "challenging-features/custom-geometry/drawingml_effect_container.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/scanny/python-pptx/master/features/steps/test_files/dml-effect.pptx",
            "description": "DrawingML: Effect container hierarchy with multiple chained shape filters"
        },
        {
            "rel_path": "challenging-features/tables/table_styles_and_cells.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/scanny/python-pptx/master/features/steps/test_files/tbl-cell.pptx",
            "description": "Tables: DrawingML table with cell formatting, borders, and margins"
        },

        # Typography & Alignments
        {
            "rel_path": "challenging-features/typography/thai_script_distributed_alignment.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/O14ISOStrict/Graphics/algnThaiDist_mainLvl5ppr_AlignmentLevel5ThaiDistributed.pptx",
            "description": "Typography: Thai distributed script text justification (`algnThaiDist`)"
        },
        {
            "rel_path": "challenging-features/typography/justified_low_text_alignment.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/test/DocumentFormat.OpenXml.Tests.Assets/assets/TestDataStorage/O14ISOStrict/Graphics/algnJustLow_mainLvl4ppr_AlignmentLevel4JustifiedLow.pptx",
            "description": "Typography: Justified low text paragraph alignment (`algnJustLow`)"
        },
        {
            "rel_path": "challenging-features/custom-geometry/overlapping_relations_zorder.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/OverlappingRelations.pptx",
            "description": "Architecture: Complex overlapping relations and z-order sorting"
        },
        {
            "rel_path": "challenging-features/animations/transitions_and_timing_nodes.pptx",
            "category": "challenging-features",
            "url": "https://raw.githubusercontent.com/apache/poi/trunk/test-data/slideshow/SampleShow.pptx",
            "description": "Timing: Slide show transitions, trigger delays, and timing nodes"
        }
    ]
    items.extend(challenging)

    print(f"Total manifest entries prepared: {len(items)}")
    with open('tools/corpus_manifest_input.json', 'w', encoding='utf-8') as f:
        json.dump(items, f, indent=2, ensure_ascii=False)
    print("Saved tools/corpus_manifest_input.json")

if __name__ == '__main__':
    main()
