/*
 * Locket image editing client. No local mock or API key is used here.
 * Configure LOCKET_AI_ENDPOINT and LOCKET_AI_TOKEN in the local setup page.
 * Missing configuration or a failed backend call leaves the original request intact.
 * Surge API reference: https://manual.nssurge.com/scripting/api.html
 * Request result: https://manual.nssurge.com/scripting/http-request.html
 * Shadowrocket/iPhone compatibility still requires an actual device test.
 */
(function () {
    var finished = false;
    var watchdog;
    var endpointPattern = /^https:\/\/(?:api\.locketcamera\.com|us-central1-locket-4252a\.cloudfunctions\.net)\/generateFilteredImage\/?(?:\?[^#]*)?$/i;
    var imageFields = ["imageUrl", "image_url", "inputUrl", "input_url", "url", "downloadUrl", "download_url"];
    // Self-contained preset data derived from references/hakaiz-ai-catalog.json and
    // dtuandzxyz/Locket-Filter-Module js/locket_pb_req.js at 9c2ea58aaea3f6d9258b60d3cf1621ea6a4ccdce.
    // Missing source prompts use explicit editing instructions, never symbolic IDs.
    var prompts = {
        "rose_flower": "Show the person in the photo with the exact same pose and background, but have them with a single rose in their mouth. If no person is present in the input, do not add anything to the output.",
        "shrek_ogre": "Show the person in the photo with the exact same pose and background, but transform them into Shrek with rounded ears, and rustic clothing while preserving the pose. Keep their hairstyle, but make it look natural in the Shrek style.",
        "superhero_cape": "Show the person in the photo with the exact same pose and background, but suit them up like a superhero in a blue and red outfit with a flowing cape while keeping their pose and framing identical.",
        "spooky_ghost": "Show the person in the photo with the exact same pose, expression, and background, but subtly insert a realistic-looking ghost somewhere in the background. If no person is present, do not add any people to the output.",
        "pirate_hat": "Show the person in the photo with the exact same pose and background, but dress them like a pirate from Pirates of the Caribbean while keeping their pose and facial expression identical.",
        "volcano_lava": "Show the person in the photo with the exact same pose, background, and facial expression, but replace the ground with molten lava, glowing magma cracks, and volcanic sparks while keeping them rooted to the spot. If no face is present, do not show any people in the output, only ever show people who were in the original input image.",
        "rain_storm": "Retain the exact pose, facial features, distance, and background from the original image. Dress the subject as a character from the Wuthering Heights movie.\n\nFor Men: Dress them in the Jacob Elordi style with matching hair and outfit.\n\nFor Women: Dress them in the Margot Robbie style: A dramatic, historical-inspired red gown with a high-gloss, lacquered red skirt that is extremely voluminous and structured, forming a full bell shape from the waist down if that part is visible in the initial image. The skirt looks stiff and reflective, almost like polished vinyl. The bodice is corset-style, fitted tightly to the torso in the same glossy red material, with thin shoulder straps, a wide scoop rounded neckline, and the dress cinching the waist and creating a structured, corset-inspired silhouette WITHOUT visible boning, lacing or busks, and featuring a sheer billowing white long puffed sleeve shirt worn underneath with a scooped neckline for the white undershirt peeking out from behind the dress.\n\nConstraints: Do not modify the person's physical features, body shape, or positioning. Keep the framing and background 100% unchanged. If no person is present, return the image unaltered. Do not include Jacob Elordi or Margot Robbie themselves in the output image.",
        "fortnite_llama": "Show the person in the photo with the exact same pose, expression, and background, but make the entire scene look like it was rendered inside a video game, similar to the style of Fortnite. Show no extra overlays or text on top of the photo. If no person is present, do not add any people to the output.",
        "watercolor_art": "Show the person in the photo with the exact same pose, expression, and background, but render the entire scene as a watercolor painting with flowing brush strokes. If no person is present, do not add any people to the output.",
        "golden_hour": "Show the person in the photo with the exact same pose, expression, and background, but make the scene look like it was captured during peak golden hour with warm sunlight and long shadows. If no person is present, do not add any people to the output.",
        "jungle_leaf": "Show the person in the photo with the exact same pose, background, and facial expression, but with their background surroundings overgrown with plants in a seamless way. The person and their background should remain in the same positions. If no face is present, do not show any people in the output, only ever show people who were in the original input image.",
        "cute_zombie": "Show the person in the photo with the exact same pose and background, but turn them into a zombie while keeping their pose and expression identical.",
        "fireworks": "Show the person in the photo with the exact same pose and background, but fill the scene with fireworks exploding in the night sky and reflecting colorful light onto the subject. Ensure the person is in the exact same pose and positioning within the frame. If no face is present, do not show any people in the output, only ever show people who were in the original input image.",
        "new_year_2026": "Show the person in the photo with the exact same pose and background, but have them wearing decorative glasses that say Happy New Year 2026. Ensure the person is in the exact same pose and positioning within the frame. If no face is present, do not show any people in the output, only ever show people who were in the original input image.",
        "harry_potter": "Show the person in the photo with the exact same pose and background, but show them as a character from Harry Potter wearing a robe of one of the four houes. Keep the pose and framing identical and do not change the background.",
        "minecraft": "Show the person in the photo with the exact same pose, expression, and background, but make everything in the scene look like it was created from Minecraft-style blocks and show people as Minecraft characters. If no person is present, do not add any people to the output.",
        "fire_flame": "Show the persons in the photo with the exact same pose and background, but with a dramatic theatrical flame effect appearing just in front of the subject's face, as if they are performing a fantasy fire-breathing act, captured with a modern iPhone camera look.\n\nThe flame should appear as a staged visual effect, suspended in front of the mouth area without showing fire originating from inside the body. Keep the effect believable and cinematic, with a bright yellow-white core, orange and red edges, subtle motion blur, and gentle heat distortion in the nearby air.\n\nAdd a soft warm glow on nearby facial features and clothing, consistent with the flame's position, while preserving the original lighting of the scene. Do not show burns, smoke inhalation, injury, pain, damage, or distress. Do not alter the person's face, expression, identity, or pose.\n\nKeep the background, framing, depth of field, and image quality identical to the original, with the flame effect appearing as a safe staged performance element captured in-camera. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "giant_spider": "Show the person in the photo with the exact same pose, expression, and background, but place a realistic spider perched on them somewhere, such as their shoulder or head. If no person is present, do not add any people to the output.",
        "ocean_underwater": "Show the person in the photo with the exact same pose, background, and facial expression, but as if them and their surrounding environment was underwater. If no face is present, do not show any people in the output, only ever show people who were in the original input image.",
        "ufo_alien": "Show the person in the photo with the exact same pose and background, but show a subtle UFO hovering in the sky or an alien somewhere hidden somewhere in the user's background. If no face is present, do not show any people in the output, only ever show people who were in the original input image.",
        "disco_lights": "Show the persons in the photo with the exact same pose and background, but with disco-style lighting effects cast across the scene, captured with a modern iPhone camera look.\n\nAdd dynamic, multicolored disco light patterns projected onto the subject and background, including soft circular light spots and scattered beams in colors like red, blue, green, and purple. The lights should appear as if coming from an off-camera rotating disco ball or party light, with varying intensity and size across the frame.\n\nEnsure the light spots wrap naturally over the contours of the face, clothing, and environment, slightly warping with surface curvature. Some lights can appear sharper while others are softly diffused depending on depth of field and distance. Include subtle motion blur or variation in brightness to suggest movement without overwhelming the image.\n\nThe lighting should interact realistically with the existing scene, blending with the original light sources rather than replacing them. Maintain proper shadow behavior and avoid flattening the subject.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp subject detail, balanced highlights and shadows, and slightly vibrant but realistic colors. The disco lights should inherit this same processing so they feel captured in-camera.\n\nDo not alter the person’s face, expression, identity, or pose. Keep the background, framing, depth of field, and image quality exactly the same, with the lighting effect appearing as a natural part of the scene. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "influencer": "Show the persons in the photo with the exact same pose and background, but with a hyperbolic \"influencer\" makeup look applied to the face, captured with a modern iPhone camera look.\n\nEnhance the eyebrows so they appear highly sculpted and precisely shaped, with sharp definition and fuller density while preserving the original eyebrow placement and bone structure. The brows should have clean edges, slightly darker pigment, and visible individual hair strokes so they look groomed rather than painted.\n\nAdd long, dramatic fake eyelashes that extend outward and upward from the natural lash line. The lashes should appear thick and layered with subtle tapering at the ends, curving naturally with the eyelid and casting faint shadows onto the upper cheek area.\n\nEnhance the lips with a glossy finish and visibly enlarged lip volume, resembling cosmetic lip injections. The lips should appear fuller and more plump while maintaining the person's original lip shape and proportions. Add natural specular highlights and reflective gloss texture across the surface to create a shiny appearance, with slight light reflections consistent with the scene.\n\nAll enhancements should remain confined strictly to the facial features. Do not alter the overall head size, face shape, or identity. Preserve natural skin texture, pores, and lighting so the makeup integrates realistically with the environment.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp facial detail, balanced highlights and shadows, and slightly vibrant but realistic colors. The enhancements should inherit this same processing so they feel captured in-camera.\n\nKeep the background, pose, framing, depth of field, and image quality exactly the same. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "princess": "Show the person in the photo with the exact same pose and background, but portray them as a prince charming or a beautiful princess from a fairytale.",
        "looks_maxxing": "Give the people an exaggerated fashion-model look with a defined jawline, prominent cheekbones and groomed eyebrows. Preserve their identity, pose, framing and original background.",
        "beard": "Show the persons in the photo with the exact same pose and background, but with a full, full-length beard added to the face, captured with a modern iPhone camera look.\n\nGenerate a dense, natural beard that covers the cheeks, jawline, chin, and connects to the mustache, extending to a full length appropriate to the subject's proportions (ranging from medium-full to longer, but not exaggerated beyond realism). The beard should match the subject's existing hair color exactly, including undertones, and reflect their natural hair type (straight, wavy, or curly). Ensure consistent density variation, with slightly lighter growth on the upper cheeks and fuller density along the jaw and chin.\n\nThe beard should grow from the natural follicle pattern of the face, following realistic growth directions and contours. Include subtle variation in strand thickness, length, and color for realism, along with natural tapering at the edges. The mustache should integrate seamlessly with the beard, resting naturally over the upper lip without obscuring it excessively unless consistent with realistic growth.\n\nEnsure the beard conforms to the face without altering facial structure, jaw size, or head proportions. Maintain the exact silhouette of the face aside from the added hair volume. Add soft shadows within the beard and where it meets the skin to create depth, and include subtle highlights where light hits the hair.\n\nPreserve skin texture at the edges and beneath thinner areas of the beard. Ensure lighting, color, and depth match the original scene so the beard appears naturally present.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp detail, balanced highlights and shadows, and true-to-life but slightly vibrant colors.\n\nDo not alter the subject's face, expression, identity, or pose. Keep the background, framing, depth of field, and image quality exactly the same, with the beard appearing as if it were naturally grown. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "slimed": "Show the persons in the photo with the exact same pose and background, but with thick green Nickelodeon-style slime being poured and splashing throughout the scene, captured with a modern iPhone camera look.\n\nAdd viscous, glossy green slime cascading from above, interacting naturally with gravity and the subject’s position. The slime should have a semi-translucent, gel-like consistency with varying thickness, forming drips, strands, and splashes as it makes contact with the subject and nearby surfaces. Allow the slime to accumulate realistically on horizontal surfaces such as shoulders, head, and any visible objects, with uneven pooling and slow drips forming.\n\nEnsure the slime conforms tightly to the subject where it touches, wrapping over contours of the face, hair, and clothing without altering underlying structure. Include small splatter droplets suspended mid-air at different depths, with some slightly motion-blurred to convey movement.\n\nLighting should interact strongly with the slime’s glossy surface, producing bright specular highlights and subtle internal scattering, while still matching the scene’s original light direction and intensity. Shadows should deepen slightly beneath thicker accumulations.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp subject detail, slightly enhanced contrast, and true-to-life but subtly vibrant greens that remain believable. The slime should inherit the same processing so it feels captured in-camera.\n\nDo not alter the person’s face, expression, identity, or pose. Keep the background, framing, depth of field, and image quality exactly the same, with the slime appearing as a natural, in-camera event. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "cowboy_cowgirl": "Show the persons in the photo with the exact same pose and background, but with subjects dressed in Western attire appropriate to each person, captured with a modern iPhone camera look.\n\nIf a person is a woman, replace that person's clothing with cowgirl-style clothing made from white cowhide with natural brown spots. The outfit should include a cowhide cowgirl hat with the same white-and-brown spotted pattern, a fitted cowhide vest or jacket, and coordinating Western-style clothing that fits naturally to the body. The cowhide texture should show realistic hair-on-hide patterning with slight irregularity in the brown patches. The hat should sit naturally on the head without altering the hairline or head shape.\n\nIf a person is a man, replace that person's clothing with classic cowboy attire. Include a traditional brown cowboy hat made from felt or leather, worn naturally on the head. Pair it with Western-style clothing such as a button-up shirt, cowboy jacket or vest, and appropriate Western textures. The hat should follow the head's shape and lighting realistically.\n\nApply the appropriate styling independently to each person in the photo based on that person's gender presentation. Do not combine multiple looks onto the same person.\n\nEnsure all clothing materials respond to the scene's lighting with natural highlights, shadows, and texture. Cowhide surfaces should have subtle directional texture and pattern variation, while hats and fabrics should show realistic folds and structure consistent with the subject's pose.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp detail, balanced highlights and shadows, and true-to-life but slightly vibrant colors so the clothing appears captured in-camera.\n\nDo not alter the subjects' faces, expressions, identities, or head proportions. Keep the background, pose, framing, depth of field, and image quality exactly the same. Do not create a split-screen, collage, side-by-side layout, duplicated frame, or any multi-panel composition. The result must remain a single continuous photo. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "clown": "Show the persons in the photo with the exact same pose and background, but styled as clowns, captured with a modern iPhone camera look.\n\nAdd a multicolored clown wig composed of bright, fluffy curls in colors such as red, blue, yellow, and green. The wig should appear soft and voluminous with natural curl variation. It should sit naturally on the head without changing the underlying head shape or hairline.\n\nPlace a classic round clown nose on the subject’s nose. The nose should be bright red with a slightly matte rubber texture and soft specular highlights consistent with the scene’s lighting. It should fit naturally over the nose with a faint contact shadow where it meets the skin.\n\nReplace the subject’s clothing with a clown costume featuring bright, playful colors and soft fabric textures. The costume can include bold multicolored panels, oversized buttons, and loose-fitting sleeves or ruffles. The fabric should drape naturally with realistic folds and movement based on the subject’s posture.\n\nEnsure the wig, nose, and costume all interact realistically with the lighting and environment, with proper highlights, shadows, and depth.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp detail, balanced highlights and shadows, and slightly vibrant but realistic colors so the costume appears captured in-camera.\n\nDo not alter the subject’s face, expression, identity, pose, or background. Keep the framing, depth of field, and image quality exactly the same. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "tatted": "Show the persons in the photo with the exact same pose and background, but with face tattoos applied, captured with a modern iPhone camera look.\n\nAdd a forehead tattoo that reads \"Locket\" in an Old English / blackletter-style font. The text should be centered horizontally across the forehead, following the natural curvature of the skin. The lettering should be dark (black or very dark ink), with sharp edges, slight ink spread, and subtle skin absorption so it appears embedded in the skin rather than overlaid. Maintain slight distortion based on the curvature of the forehead and facial expression.\n\nOn the subject's right cheek (viewer's left if facing forward), place a small heart tattoo in the position where a teardrop tattoo would typically sit, just below the outer corner of the eye. The heart should be simple, clean-lined, and filled or slightly shaded, with natural ink softness at the edges.\n\nEnsure both tattoos integrate realistically with the skin, preserving pores, texture, and underlying highlights and shadows. The tattoos should not appear overly crisp or floating, and should follow the lighting of the scene with subtle fading where light hits more strongly.\n\nDo not alter the subject's face shape, expression, identity, or proportions. Keep the background, pose, framing, depth of field, and image quality exactly the same.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp detail, balanced highlights and shadows, and true-to-life but slightly vibrant colors, so the tattoos appear naturally captured in-camera. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "bye_brows": "Show the persons in the photo with the exact same pose and background, but with only the eyebrow hair removed.\n\nRemove all visible eyebrow hair strictly within the natural eyebrow region, without altering any surrounding areas. The shape, size, and silhouette of the head must remain exactly the same. Do not modify or remove any hair on the scalp, hairline, eyelashes, or facial hair outside of the eyebrows.\n\nPreserve the natural brow ridge and skin beneath, showing realistic skin texture with fine pores and subtle tonal variation where the eyebrows were. Avoid overly smooth or blurred skin. Include very faint follicle shading or slight discoloration to maintain realism, but no visible hairs.\n\nEnsure lighting, shadows, and color match the original image exactly, with no new shading that would imply structural changes. Do not alter facial proportions, expression, or identity in any way.\n\nKeep the background, pose, framing, depth of field, and image quality identical to the original, with the only change being the absence of eyebrow hair. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "bowling_ball": "Show the persons in the photo with the exact same pose and background, but with a completely bald head.\n\nRemove all scalp hair while strictly preserving the original head shape, size, and silhouette. Do not expand, round, or alter the contour of the skull in any way. The hairline should be cleanly removed, revealing the natural scalp beneath, with the same proportions as the original head.\n\nThe scalp should appear smooth and clean with realistic skin texture, including fine pores and subtle tonal variation. Add a gentle, natural sheen to the scalp, with soft specular highlights that follow the lighting direction of the scene, giving a slightly shiny appearance without looking wet or overly reflective. Ensure highlights fall naturally along the curvature of the head and do not introduce artificial brightness.\n\nMaintain accurate shadowing around the head and where hair previously cast subtle shadows, adjusting only as needed to reflect the absence of hair while keeping the overall lighting consistent.\n\nDo not alter the person’s face, expression, or identity. Do not modify eyebrows, eyelashes, or any other facial hair unless already absent. Keep the background, pose, framing, depth of field, and image quality exactly the same, with the bald head appearing as if it were originally captured. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "blonde_bleached": "Show the persons in the photo with the exact same pose and background, but with a buzzed and bleached hairstyle.\n\nThe hair should be cut extremely close to the scalp (short buzz cut, nearly stubble length), clearly following the true contour of the skull. Do not add any additional volume or thickness that would expand the silhouette of the head. The outer edge of the head shape must remain identical to the original image, with no enlargement or rounding. The hair should read as a thin layer of texture on top of the existing scalp, not as a separate mass.\n\nThe color should be a clean, bleached blonde with slightly warm undertones, with subtle tonal variation across the scalp to maintain realism. Preserve visible scalp underneath the hair, with fine, short hair grain that blends seamlessly into the skin. Include slight natural irregularity in density and tone so it does not appear flat or painted on.\n\nEnsure lighting behaves consistently with the original image, with very soft highlights across the top of the scalp and gentle falloff along the sides, without introducing new shadow shapes that would imply added volume. Maintain accurate skin texture, pores, and natural variation.\n\nDo not alter the person’s face, expression, hairline position, or head proportions in any way. Keep the background, pose, framing, depth of field, and image quality exactly the same, with the hairstyle appearing as if it were originally captured. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "bob_cut": "Show the persons in the photo with the exact same pose and background, but with their hair cut into a bob hairstyle, captured with a modern iPhone camera look.\n\nTransform the hair into a chin-length bob cut that frames the face evenly on both sides. The cut should follow a clean horizontal line around the jaw area, with slight inward curvature at the ends. Maintain the subject's original hair type, whether straight, wavy, or curly, preserving its natural texture, density, and movement rather than forcing a different style.\n\nKeep the original hairline, parting, and color exactly the same. Only adjust the length and shape to achieve the bob. Ensure the volume remains realistic and does not enlarge the head shape. The silhouette of the head should stay consistent, with the bob sitting naturally against it.\n\nAdd subtle layering or softness at the ends so the cut does not appear overly blunt or artificial. Include natural strand variation, slight flyaways, and realistic edge detail.\n\nEnsure lighting interacts naturally with the hair, with highlights and shadows consistent with the scene. Preserve depth and texture so the hair appears physically present.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp detail, balanced highlights and shadows, and true-to-life but slightly vibrant colors.\n\nDo not alter the subject's face, expression, identity, or pose. Keep the background, framing, depth of field, and image quality exactly the same, with the hairstyle appearing as if it were naturally worn during capture. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "mohawk": "Show the persons in the photo with the exact same pose and background, but with a mohawk hairstyle featuring shaved sides and a raised center strip, captured with a modern iPhone camera look.\n\nShave the hair on both sides of the head cleanly and closely to the scalp, following the natural head contour without changing the head shape or size. The shaved areas should show subtle scalp texture and natural tonal variation, with soft lighting and no added volume.\n\nIn the center, create a defined strip of longer hair running from the forehead to the back of the head. Style this strip upward so it stands raised and structured, with height and shape appropriate to the subject's original hair type. If the hair is straight, it should appear slicked up and slightly spiked with natural separation and light hold. If the hair is wavy or curly, preserve that texture in the raised section with volume and definition rather than forcing it straight.\n\nEnsure the hairline remains exactly the same and the silhouette of the head is not enlarged beyond the natural volume of the styled center strip. Add subtle flyaways and strand variation for realism.\n\nLighting should interact naturally with the hair, with highlights on the raised center and softer tones on the shaved sides. Maintain realistic shadows and depth consistent with the original scene.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp detail, balanced highlights and shadows, and true-to-life but slightly vibrant colors.\n\nDo not alter the subject's face, expression, identity, or pose. Keep the background, framing, depth of field, and image quality exactly the same, with the hairstyle appearing as if it were naturally styled during capture. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "braces": "Show the persons in the photo with the exact same pose and background, but with multicolored braces visible on their teeth, captured with a modern iPhone camera look.\n\nIf the subject's teeth are already visible, add orthodontic braces to the upper teeth (and lower teeth if visible). The braces should include small metallic brackets bonded to each tooth, connected by a thin archwire. Each bracket should have colored elastic bands in a variety of hues (such as red, blue, green, yellow, purple), arranged in a mixed, non-uniform pattern for a playful look.\n\nIf the subject is not already smiling with visible teeth, adjust only the mouth expression to a natural, slight smile that reveals the teeth so the braces are clearly visible. Do not alter the rest of the facial expression or facial structure beyond what is necessary to reveal the teeth.\n\nEnsure the braces integrate realistically with the teeth, with proper reflections on the metal brackets and subtle translucency in the colored bands. Lighting inside the mouth should remain consistent with the scene, with natural shadowing and highlights.\n\nPreserve the subject's identity, face shape, and proportions exactly. Do not enlarge or distort the mouth, teeth, or head. Maintain natural skin texture and surrounding facial features.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp detail, balanced highlights and shadows, and true-to-life but slightly vibrant colors.\n\nKeep the background, pose, framing, depth of field, and image quality exactly the same, with the braces appearing as a natural, in-camera detail. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "flower_crown": "Show the persons in the photo with the exact same pose and background, but wearing a mixed wildflower crown.\n\nThe crown should be composed of a natural assortment of small wildflowers and greenery, including varied shapes and colors such as soft whites, yellows, purples, pinks, and light blues. Include delicate leaves and thin stems woven together into a slightly irregular, hand-made arrangement rather than a perfectly uniform band.\n\nPosition the crown so it rests naturally on top of the head, following the exact contour of the hair without altering the hairline, volume, or head shape. The flowers should sit lightly against the hair, with slight compression where they make contact and small overlaps between petals and strands for realism.\n\nEnsure the materials respond to the scene's lighting, with soft highlights on petals and subtle shadowing beneath the crown where it meets the hair. Colors should feel slightly varied and organic, not overly saturated or artificial.\n\nDo not change the person's face, expression, or any existing features. Keep the background, pose, framing, depth of field, and image quality exactly the same, with the crown appearing as if it were naturally worn in the original photo. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "giraffe": "Show the persons in the photo with the exact same pose and background, but with the subject wearing a giraffe costume, captured with a modern iPhone camera look.\n\nReplace the subject's clothing with a full giraffe costume suit featuring the recognizable giraffe pattern of warm tan fabric with irregular brown patches. The costume should appear soft and plush, like a wearable animal onesie or mascot-style outfit. Ensure the fabric has a slightly fuzzy texture with natural folds and compression consistent with the subject's pose.\n\nInclude a giraffe hood attached to the costume with small giraffe ears and short ossicones (the horn-like structures) on top. The hood should rest naturally on the head without changing the head shape or hairline. The giraffe face portion should sit above the subject's forehead like a costume hood rather than covering the subject's face, leaving the face fully visible.\n\nThe costume should follow the subject's body naturally with realistic fabric draping, wrinkles at joints, and gentle tension across the torso or shoulders depending on the pose. If hands or feet are visible, the costume may extend to matching giraffe-pattern sleeves or coverings, but do not add limbs if they are not present in the original image.\n\nEnsure the costume interacts naturally with the scene's lighting, with soft highlights on the plush fabric and shadows within folds. The giraffe pattern should vary slightly in shape and tone to feel organic rather than repeated.\n\nApply modern iPhone camera characteristics across the entire image: natural HDR, crisp detail, balanced highlights and shadows, and slightly vibrant but realistic colors.\n\nDo not alter the subject's face, expression, identity, or pose. Keep the background, framing, depth of field, and image quality exactly the same, with the costume appearing as if it were worn during capture. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "leprechaun": "Show the person in the photo with the exact same pose, framing, expression, and background, but dress them in leprechaun costume: a green top hat with a gold buckle and black band as well as matching outfit. Keep their pose and background identical. Do not change the person’s face, hairstyle, body shape, position in frame, likeness, or facial expression. Do not remove anyone from the original photo. Do not add extra people or limbs. If no person is present, return the image unaltered. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "lucky_face": "Show the person in the photo with the exact same pose and background, but add cute, subtle freckles concentrated across the bridge of the nose and upper cheeks. Add small green clover sticker decals on both cheeks (one per cheek), glossy sticker texture with clean edges. Keep the person's likeness, pose, lighting, and background unchanged. Photorealistic, natural skin texture, no extra makeup, no other changes. If no person is present, return the image unaltered. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "elf_cutout": "Show the person in the photo with the exact same pose and background, but dressed up as an Elf. Ensure the person is in the exact same pose and positioning within the frame. If no face is present, do not show any people in the output, only ever show people who were in the original input image.",
        "santa_cutout": "Show the person in the photo with the exact same pose and background, but dressed up as Santa Claus. Ensure the person is in the exact same pose and positioning within the frame. If no face is present, do not show any people in the output, only ever show people who were in the original input image.",
        "easter_chick_cutout": "Show the persons in the photo with the exact same pose and background, but put them in a bright yellow Easter chick costume: a fluffy yellow onesie suit with a rounded hood, small orange beak on the hood above the forehead, and tiny chick wings as sleeves. Add soft plush texture and natural folds. Keep the person’s face, hairline (if visible), pose, and background exactly the same. If any of the body parts mentioned (for example hands and feet) are not present, do not add them to the photo. If no people are present, return the image unaltered. Do not change the overall compsition of the photo, do not add new people to the photo, only show each person in the photo one time.",
        "okay_wig": "Give the people in the photo bright orange, curly wigs. Preserve each person's face, expression, pose, framing and original background.",
        "toothless": "Give the people in the photo a playful toothless smile by removing only visible teeth. Preserve identity, facial proportions, pose, framing and background.",
        "buns": "Style each person's hair into two neat hair buns. Preserve identity, facial expression, hair color, pose, framing and background.",
        "cash_money": "Add floating banknotes and a playful money-themed atmosphere around the people. Preserve faces, identity, pose, framing and background.",
        "happy_birthday": "Add a birthday cake, colorful balloons and subtle confetti. Preserve the people, their identity, pose, framing and background.",
        "cutesy": "Add a cute pastel style with small hearts and sparkles. Preserve identity, facial expression, pose, framing and background.",
        "sticker_face": "Place small colorful playful sticker decals on the cheeks and forehead. Preserve identity, expression, natural skin texture, pose, framing and background.",
        "love_bug": "Add cute heart-shaped face stickers and delicate heart accents around the people. Preserve identity, facial features, pose, framing and background.",
        "wedding": "Dress the people in elegant wedding attire with realistic fabric and lighting. Preserve their faces, identity, pose, framing and background.",
        "sweet_hearts": "Add small pastel heart decorations and subtle romantic sparkles around the people. Preserve identity, pose, framing and background.",
        "bearded": "Give each person a festive long ginger beard while preserving their identity, facial expression, pose, framing and background.",
        "frosty": "Dress the people in a playful snowman-inspired winter costume with a scarf and top hat, keeping their faces visible. Preserve identity, pose, framing and background.",
        "easter_bunney_cutout": "Dress the people in fluffy Easter bunny costumes with long bunny ears, keeping their faces visible. Preserve identity, facial expression, pose, framing and background.",
        "locket": "Give the people a whimsical witch-inspired look with dark velvet clothing and subtle magical sparkles. Preserve faces, identity, pose, framing and background."
    };
    var promptAliases = {
        "stk_rose_flower": "rose_flower",
        "stk_shrek_ogre": "shrek_ogre",
        "stk_superhero_cape": "superhero_cape",
        "stk_spooky_ghost": "spooky_ghost",
        "stk_pirate_hat": "pirate_hat",
        "stk_volcano_lava": "volcano_lava",
        "stk_rain_storm": "rain_storm",
        "stk_fortnite_llama": "fortnite_llama",
        "stk_watercolor_art": "watercolor_art",
        "stk_golden_hour": "golden_hour",
        "stk_jungle_leaf": "jungle_leaf",
        "stk_cute_zombie": "cute_zombie",
        "stk_fireworks": "fireworks",
        "stk_new_year_2026": "new_year_2026",
        "stk_harry_potter": "harry_potter",
        "stk_minecraft": "minecraft",
        "stk_fire_flame": "fire_flame",
        "stk_giant_spider": "giant_spider",
        "stk_ocean_underwater": "ocean_underwater",
        "stk_ufo_alien": "ufo_alien",
        "stk_dio_disco": "disco_lights",
        "disco": "disco_lights",
        "stk_dio_pm2": "locket",
        "stk_dio_cash": "cash_money",
        "cash": "cash_money",
        "stk_dio_wedding": "wedding",
        "stk_dio_cowboy": "cowboy_cowgirl",
        "cowboy": "cowboy_cowgirl",
        "stk_dio_looksmaxing": "looks_maxxing",
        "looksmaxing": "looks_maxxing",
        "stk_dio_orange_wig": "okay_wig",
        "orange_wig": "okay_wig",
        "stk_dio_bleached_hair": "blonde_bleached",
        "bleached_hair": "blonde_bleached",
        "stk_dio_bob": "bob_cut",
        "bob": "bob_cut",
        "stk_dio_bearded": "beard",
        "stk_dio_bearded_holiday": "bearded",
        "stk_dio_sweat_hearts": "sweet_hearts",
        "sweat_hearts": "sweet_hearts",
        "stk_dio_elf": "elf_cutout",
        "elf": "elf_cutout",
        "stk_dio_santa": "santa_cutout",
        "santa": "santa_cutout",
        "stk_dio_easter_bunny": "easter_bunney_cutout",
        "easter_bunny": "easter_bunney_cutout",
        "stk_dio_easter_chick": "easter_chick_cutout",
        "easter_chick": "easter_chick_cutout",
        "stk_dio_toothless": "toothless",
        "stk_dio_bye_brows": "bye_brows",
        "stk_dio_bowling_ball": "bowling_ball",
        "stk_dio_buns": "buns",
        "stk_dio_tatted": "tatted",
        "stk_dio_mohawk": "mohawk",
        "stk_dio_braces": "braces",
        "stk_dio_slimed": "slimed",
        "stk_dio_princess": "princess",
        "stk_dio_happy_birthday": "happy_birthday",
        "stk_dio_cutesy": "cutesy",
        "stk_dio_sticker_face": "sticker_face",
        "stk_dio_flower_crown": "flower_crown",
        "stk_dio_love_bug": "love_bug",
        "stk_dio_giraffe": "giraffe",
        "stk_dio_clown": "clown",
        "stk_dio_leprechaun": "leprechaun",
        "stk_dio_lucky_face": "lucky_face",
        "stk_dio_frosty": "frosty",
        "stk_dio_influencer": "influencer"
    };
    // One input image cannot implement asset-based frames or a real four-shot sequence.
    var unsupportedCompositions = {
        "frame_berry_days": true,
        "pb_strawberry": true,
        "frame_happy_snap": true,
        "pb_vintage": true,
        "frame_sky_diary": true,
        "pb_galaxy": true,
        "photobooth_4cut": true,
        "photobooth_cute": true,
        "pb_holo_4cut": true,
        "pb_scrapbook_ripped_4cut": true,
        "pb_ripped_paper_4cut": true,
        "pb_denim_ripped_2x2": true,
        "frame_classic_pb": true,
        "photoboot": true,
        "sticker_b_nh_lu_n_minh_tu": true,
        "cmt_locket": true,
        "khung_hello_kitty_pastel_ng_t_ng_o": true,
        "khung_hello_kitty_h_ng_pastel": true,
        "khung_nh_n_pastel_vi_n_ren": true,
        "khung_nh_hoa_pastel_vi_n_xanh_m_nh": true,
        "khung_nh_vu_ng_m_ng_nh_n_b_c": true,
        "khung_kh_ng_gian_xanh_pastel": true,
        "khung_vu_ng_ng_i_sao_h_ng_pastel": true,
        "khung_nh_pastel_vi_n_s_h_i_c_u": true,
        "khung_nh_shin_chan_vi_n_m_nh": true,
        "khung_anh_o_kitty_v_sao": true,
        "khung_xanh_v_tay_sao_v_ng": true,
        "sinh_nh_t_hello_kitty_ho_i_c": true,
        "pb_single_y2k_silver_holo": true,
        "pb_single_denim_ripped": true,
        "pb_single_film_nostalgia": true,
        "photobooth": true
    };

    function finish(value) {
        if (finished) return;
        finished = true;
        if (typeof clearTimeout === "function" && watchdog !== undefined) clearTimeout(watchdog);
        $done(value || {});
    }

    function diagnostic(stage, code) {
        // Only fixed codes and time are persisted. Never store request or configuration data.
        try {
            if (typeof $persistentStore !== "undefined" && typeof $persistentStore.write === "function") {
                $persistentStore.write(JSON.stringify({ stage: stage, code: code, timestamp: new Date().toISOString() }), "LOCKET_AI_STATUS");
            }
        } catch (ignored) {}
    }

    function pass(stage, code) {
        if (finished) return;
        diagnostic(stage, code);
        finish({});
    }

    function record(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    // Avoid relying on the URL WebAPI, which is not present in every JSC runtime.
    function httpsUrl(value, allowQuery) {
        if (typeof value !== "string" || value.length > 8192 || value !== value.trim()) return null;
        var match = /^https:\/\/([^\/?#\s]+)(\/[^#\s]*)?$/i.exec(value);
        if (!match) return null;
        var authority = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]{1,5}))?$/i.exec(match[1]);
        if (!authority) return null;
        var host = authority[1].toLowerCase();
        if (host.indexOf(".") < 0 || /^\d+(?:\.\d+){3}$/.test(host)) return null;
        if (!host.split(".").every(function (label) {
            return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label);
        })) return null;
        var port = authority[2] ? Number(authority[2]) : 443;
        if (port < 1 || port > 65535) return null;
        var path = match[2] || "/";
        if (!allowQuery && path.indexOf("?") !== -1) return null;
        return { origin: "https://" + host + (port === 443 ? "" : ":" + port), path: path };
    }

    function readImage(obj, fields) {
        if (!record(obj)) return "";
        for (var i = 0; i < fields.length; i++) {
            if (Object.prototype.hasOwnProperty.call(obj, fields[i]) && httpsUrl(obj[fields[i]], true)) {
                return obj[fields[i]];
            }
        }
        return "";
    }

    function resolvePreset(value) {
        var id = value.trim().toLowerCase();
        if (Object.prototype.hasOwnProperty.call(unsupportedCompositions, id)) return { code: "unsupported_composition" };
        if (Object.prototype.hasOwnProperty.call(prompts, id)) return { prompt: prompts[id] };
        if (Object.prototype.hasOwnProperty.call(promptAliases, id)) {
            return { prompt: prompts[promptAliases[id]] };
        }
        return null;
    }

    function readPrompt(body) {
        var containers = [body, body.data];
        var fields = ["prompt", "text_prompt", "instruction"];
        for (var i = 0; i < containers.length; i++) {
            if (!record(containers[i])) continue;
            for (var j = 0; j < fields.length; j++) {
                var value = containers[i][fields[j]];
                if (typeof value === "string" && value.trim()) {
                    var text = value.trim();
                    if (text.length > 4096) return { code: "prompt_too_long" };
                    var preset = resolvePreset(text);
                    if (preset) return preset;
                    // A machine key is not an editing instruction. Free-form text stays intact.
                    if (/^[a-z0-9:-]*_[a-z0-9_:-]*$/i.test(text)) return { code: "unknown_preset" };
                    return { prompt: text };
                }
            }
        }
        var hasId = false;
        for (var k = 0; k < containers.length; k++) {
            if (!record(containers[k])) continue;
            var ids = [containers[k].filterId, containers[k].filter_id];
            for (var n = 0; n < ids.length; n++) {
                if (typeof ids[n] !== "string" || !ids[n].trim()) continue;
                hasId = true;
                var resolved = resolvePreset(ids[n]);
                if (resolved) return resolved;
            }
        }
        return { code: hasId ? "unknown_preset" : "prompt_missing" };
    }

    function nativeResponse(outputUrl) {
        var urls = { outputUrl: outputUrl, output_url: outputUrl, url: outputUrl, imageUrl: outputUrl, image_url: outputUrl };
        return {
            response: {
                status: 200,
                headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
                body: JSON.stringify({ result: {
                    outputUrl: outputUrl, output_url: outputUrl, url: outputUrl,
                    imageUrl: outputUrl, image_url: outputUrl, status: 200, data: urls
                } })
            }
        };
    }

    try {
        if (typeof $response !== "undefined" || typeof $request === "undefined" || !$request) return finish({});
        if (typeof $request.url !== "string" || !endpointPattern.test($request.url)) return finish({});
        diagnostic("request", "received");
        if ($request.method && String($request.method).toUpperCase() !== "POST") return pass("request", "unsupported_method");
        if (typeof $request.body !== "string" || !$request.body || $request.body.length > 65536) return pass("request", "invalid_body");
        if (typeof $persistentStore === "undefined" || typeof $persistentStore.read !== "function") return pass("configuration", "store_unavailable");
        if (typeof $httpClient === "undefined" || typeof $httpClient.post !== "function" || typeof setTimeout !== "function") return pass("configuration", "runtime_unavailable");

        var endpointValue = $persistentStore.read("LOCKET_AI_ENDPOINT");
        var tokenValue = $persistentStore.read("LOCKET_AI_TOKEN");
        var endpoint = httpsUrl(typeof endpointValue === "string" ? endpointValue.trim() : "", false);
        var token = typeof tokenValue === "string" ? tokenValue.trim() : "";
        if (!endpointValue) return pass("configuration", "endpoint_missing");
        if (!endpoint || (endpoint.path !== "/" && endpoint.path !== "/v1/images/edit")) return pass("configuration", "endpoint_invalid");
        if (!token) return pass("configuration", "token_missing");
        if (!/^[A-Za-z0-9._~+\/-]{24,256}={0,2}$/.test(token)) return pass("configuration", "token_invalid");

        var body;
        try { body = JSON.parse($request.body); } catch (invalidJson) { return pass("input", "invalid_json"); }
        if (!record(body)) return pass("input", "invalid_json");
        var inputUrl = readImage(body, imageFields) || readImage(body.data, imageFields);
        if (!inputUrl) return pass("input", "image_missing");
        var selected = readPrompt(body);
        if (!selected.prompt) return pass("input", selected.code);
        var prompt = selected.prompt;
        var input = httpsUrl(inputUrl, true);

        // HTTP client timeout is in seconds. The local guard stays below the module's 60 seconds.
        watchdog = setTimeout(function () { pass("backend", "timeout"); }, 50000);
        diagnostic("backend", "started");
        $httpClient.post({
            url: endpoint.origin + "/v1/images/edit",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: inputUrl, prompt: prompt }),
            timeout: 45,
            "auto-redirect": false,
            "auto-cookie": false
        }, function (error, response, data) {
            if (finished) return;
            try {
                if (error) return pass("backend", "transport_error");
                if (!response || Number(response.status || response.statusCode) !== 200) return pass("backend", "http_error");
                if (typeof data !== "string" || data.length > 65536) return pass("backend", "invalid_response");
                var result;
                try { result = JSON.parse(data); } catch (invalidResponse) { return pass("backend", "invalid_response"); }
                var outputUrl = record(result) ? result.outputUrl : "";
                var output = httpsUrl(outputUrl, false);
                if (!output || output.origin !== endpoint.origin) return pass("backend", "invalid_output");
                if (!/^\/images\/[A-Za-z0-9_-]{24,128}\.(?:png|jpe?g|webp)$/.test(output.path)) return pass("backend", "invalid_output");
                if (output.origin === input.origin && output.path === input.path) return pass("backend", "unchanged_output");
                diagnostic("result", "success");
                return finish(nativeResponse(outputUrl));
            } catch (error) {
                return pass("backend", "invalid_response");
            }
        });
    } catch (error) {
        return pass("request", "runtime_error");
    }
})();
