import json
import os
from pathlib import Path
import traceback
import unreal

prefix = Path(os.environ["U5_PREFIX"])
probe = unreal.AnimBlendProbe
assets = unreal.EditorAssetLibrary
path = "/Game/InteractiveBlend/" + os.environ["U5_ASSET_LABEL"]
bp_path = path + "/ABP_Blend"


def receipt(suffix, value):
    dest = Path(str(prefix) + "-" + suffix + ".json")
    tmp = dest.with_suffix(".part")
    tmp.write_text(json.dumps(value), encoding="utf8")
    tmp.replace(dest)


def tick(_):
    if Path(os.environ["UEMCP_OWNED_QUIT_FILE"]).exists():
        if "bp" in globals() and probe.is_editor_open(bp):
            unreal.get_editor_subsystem(unreal.AssetEditorSubsystem).close_all_editors_for_asset(bp)
            return
        unreal.unregister_slate_post_tick_callback(callback)
        unreal.SystemLibrary.quit_editor()
        return
    request = Path(str(prefix) + "-request")
    if request.exists():
        try:
            cmd = json.loads(request.read_text(encoding="utf8"))
            request.unlink()
            op = cmd["op"]
            if op in ("enable-save-on-compile", "restore-save-on-compile"):
                result = probe.set_compile_save_policy(op == "enable-save-on-compile")
            elif op == "reconstruct":
                result = probe.reconstruct_alpha(bp)
            elif op == "compile-error":
                result = probe.plant_compile_error(bp)
            elif op == "members":
                result = json.loads(probe.members(bp))
            elif op == "dirty":
                result = sorted(p.get_path_name() for p in unreal.EditorLoadingAndSavingUtils.get_dirty_content_packages())
            elif op == "snapshot":
                result = json.loads(probe.inspect(bp))
            else:
                raise ValueError(op)
            receipt(cmd["label"], result)
        except Exception:
            receipt("setup-error", traceback.format_exc())


callback = unreal.register_slate_post_tick_callback(tick)
try:
    if os.environ["U5_RELOAD"] == "1":
        bp = assets.load_asset(bp_path)
        mesh = assets.load_asset(path + "/Mesh")
        assert bp and mesh
    else:
        assert not assets.does_asset_exist(bp_path)
        template = "/Engine/Tutorial/SubEditors/TutorialAssets/Character/TutorialTPP"
        skel = assets.duplicate_asset(template + "_Skeleton", path + "/Skeleton")
        mesh = assets.duplicate_asset(template, path + "/Mesh")
        tools = unreal.AssetToolsHelpers.get_asset_tools()
        factory = unreal.AnimBlueprintFactory()
        factory.set_editor_property("target_skeleton", skel)
        bp = tools.create_asset("ABP_Blend", path, unreal.AnimBlueprint, factory)
        factory = unreal.AnimSequenceFactory()
        factory.set_editor_property("target_skeleton", skel)
        seqs = [tools.create_asset(name, path, unreal.AnimSequence, factory) for name in ("PoseA", "PoseB")]
        assert probe.seed(bp, mesh, *seqs, os.environ.get("U5_SLOT_RUN") == "1")
        if os.environ.get("U5_FORMAT_ARGUMENT") == "1":
            assert probe.seed_format_argument(bp)
        unreal.BlueprintEditorLibrary.compile_blueprint(bp)
        for asset in [skel, mesh, *seqs, bp]:
            assert assets.save_loaded_asset(asset, only_if_is_dirty=False)
    editors = unreal.get_editor_subsystem(unreal.AssetEditorSubsystem)
    assert editors.open_editor_for_assets([bp])
    assert probe.is_editor_open(bp)
    receipt("ready", {"asset": bp_path, "mesh": mesh.get_path_name(), "editor_open": True})
except Exception:
    receipt("setup-error", traceback.format_exc())
