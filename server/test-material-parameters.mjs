import { ConnectionManager } from './connection-manager.mjs';
import { executeRcTool } from './rc-tools.mjs';
import { FakeHttpResponder, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('material parameter UFUNCTION dispatch');
const library = '/Script/MaterialEditor.Default__MaterialEditingLibrary';
const definitionLibrary = '/Script/UEMCP.Default__UEMCPMaterialParameterLibrary';
const asset = '/Game/Materials/MI_Test.MI_Test';
const instanceDescription = { Class: '/Script/Engine.MaterialInstanceConstant' };

for (const [type, name, value] of [
  ['Scalar', 'Roughness', 0.42],
  ['Vector', 'Tint', { R: 0.1, G: 0.2, B: 0.3, A: 1 }],
  ['Texture', 'Diffuse', '/Game/Textures/T_Test.T_Test'],
]) {
  let stored;
  const classPath = type === 'Scalar' ? '/Script/Landscape.LandscapeMaterialInstanceConstant'
    : type === 'Vector' ? '/Script/Test.CustomMaterialInstanceConstant' : instanceDescription.Class;
  const mock = new FakeHttpResponder().on('PUT /remote/object/describe', { Class: classPath }).on('PUT /remote/object/call', (_port, _method, _path, body) => {
    if (body.functionName === 'ClassIsChildOf') {
      if (body.objectPath !== '/Script/Engine.Default__KismetMathLibrary'
        || body.parameters.TestClass !== classPath || body.parameters.ParentClass !== instanceDescription.Class) {
        throw new Error('Invalid native inheritance probe');
      }
      return { ReturnValue: true };
    }
    if (body.functionName === 'GetGlobalParameterNames') {
      if (body.objectPath !== definitionLibrary || body.parameters.ParameterType !== type) throw new Error('Invalid native definition lookup');
      return { ReturnValue: [name] };
    }
    if (body.objectPath !== library) throw new Error('Target is not the reflected library CDO');
    if (body.functionName === `Get${type}ParameterNames`) return { ParameterNames: [name] };
    if (body.functionName === `SetMaterialInstance${type}ParameterValue`) {
      stored = body.parameters.Value;
      return { ReturnValue: false }; // UE 5.8 writes successfully but always returns false.
    }
    if (body.functionName === `GetMaterialInstance${type}ParameterValue`) return { ReturnValue: stored };
    throw new Error('Function does not exist on object');
  }).on('PUT /remote/object/property', () => ({
    [`${type}ParameterValues`]: [{
      ParameterInfo: { Name: name, Association: type === 'Scalar' ? 2 : type === 'Vector' ? 'Global Parameter' : 'GlobalParameter', Index: -1 },
      ParameterValue: stored,
    }],
  }));
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  try {
    const result = await executeRcTool('set_material_parameter', {
      asset_path: asset, parameter_name: name.toLowerCase(), value,
    }, conn);
    t.assert(result.verified === true, `${type}: lowercase FName and valid MIC subclass succeed with a verified override`);
    const call = mock.calls.find(c => c.body.functionName?.startsWith('SetMaterialInstance'));
    t.assert(call?.body.parameters.Instance === asset && call.body.parameters.ParameterName === name,
      `${type}: setter receives the instance reference and parameter name`);
    t.assert(call?.body.parameters.Association === 'GlobalParameter', `${type}: uses global parameter association`);
  } catch (error) {
    t.assert(false, `${type}: reflected setter round-trip`, error.message);
  }
}

for (const [type, name, value] of [
  ['Scalar', 'LayerOnly', 0],
  ['Vector', 'LayerOnly', { R: 0, G: 0, B: 0, A: 1 }],
  ['Texture', 'LayerOnly', '/Game/Textures/T_Test.T_Test'],
]) {
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', instanceDescription)
    .on('PUT /remote/object/call', (_port, _method, _path, body) => {
      if (body.functionName === 'GetGlobalParameterNames') return { ReturnValue: [] };
      if (body.functionName === `Get${type}ParameterNames`) return { ParameterNames: [name] };
      return { ReturnValue: value };
    })
    .on('PUT /remote/object/property', { [`${type}ParameterValues`]: [{
      ParameterInfo: { Name: name, Association: 'Global Parameter', Index: -1 }, ParameterValue: value,
    }] });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: name, value,
  }, conn), /global.*definition|not found/i, `${type}: an orphan override cannot substitute for a global definition`);
  t.assert(!mock.calls.some(call => call.body.functionName?.startsWith('SetMaterialInstance')),
    `${type}: a layer-only name is rejected before mutation`);
}

for (const [type, name, value] of [
  ['Scalar', 'Roughness', 0],
  ['Vector', 'Tint', { R: 0, G: 0, B: 0, A: 1 }],
  ['Texture', 'Diffuse', '/Game/Textures/T_Test.T_Test'],
]) {
  for (const overrides of [[], [{
    ParameterInfo: { Name: name, Association: 'LayerParameter', Index: 0 }, ParameterValue: value,
  }], [{
    ParameterInfo: { Name: name, Association: 'GlobalParameter', Index: -1 }, ParameterValue: null,
  }]]) {
    const mock = new FakeHttpResponder()
      .on('PUT /remote/object/describe', instanceDescription)
      .on('PUT /remote/object/call', (_port, _method, _path, body) => (
        body.functionName === 'GetGlobalParameterNames' ? { ReturnValue: [name] } : { ReturnValue: value }
      ))
      .on('PUT /remote/object/property', { [`${type}ParameterValues`]: overrides });
    const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
    await t.assertRejects(() => executeRcTool('set_material_parameter', {
      asset_path: asset, parameter_name: name, value,
    }, conn), /global override/i, `${type}: matching effective value alone cannot certify a missing, layered, or mismatched override`);
  }
}

{
  const mock = new FakeHttpResponder().on('PUT /remote/object/describe', instanceDescription).on('PUT /remote/batch', (_port, _method, _path, body) => ({
    Responses: body.Requests.map(({ Body }) => ({
      ResponseCode: Body.objectPath === library && Body.functionName === 'GetScalarParameterNames' ? 200 : 400,
      ResponseBody: { ParameterNames: ['InheritedScalar'] },
    })),
  }));
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  const result = await executeRcTool('list_material_parameters', { include_details: false, asset_path: asset }, conn);
  t.assert(result.scalar[0]?.Name === 'InheritedScalar', 'listing decodes reflected name arrays, including inherited parameters');
  t.assert(result._subErrors?.length === 2, 'listing preserves partial-failure diagnostics');
  t.assert(result.info_fields?.join(',') === 'Name', 'listing declares names-only metadata without inventing IDs or layer indices');
}

{
  const mock = new FakeHttpResponder().on('PUT /remote/object/describe', instanceDescription).on('PUT /remote/object/call', (_port, _method, _path, body) => {
    if (body.functionName === 'GetGlobalParameterNames') return { ReturnValue: ['Roughness'] };
    return { ReturnValue: 0.1 };
  });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'Roughness', value: 0.9,
  }, conn), /readback/i, 'a no-op setter cannot report success');
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'Missing', value: 0,
  }, conn), /not found/i, 'an unknown parameter is rejected before writing, even for a zero value');
}

{
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', instanceDescription)
    .on('PUT /remote/object/call', (_port, _method, _path, body) => (
      body.functionName === 'GetGlobalParameterNames' ? { ReturnValue: ['Roughness'] } : { ReturnValue: 0 }
    ));
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'Roughness', value: 0.0000005,
  }, conn), /readback/i, 'float tolerance does not hide a small nonzero write that stayed zero');
}

for (const classPath of ['/Script/Engine.Material', '/Script/Engine.MaterialInstanceDynamic', '/Script/Test.DerivedDynamicInstance']) {
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', { Class: classPath })
    .on('PUT /remote/object/call', { ReturnValue: false });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'Roughness', value: 0,
  }, conn), /MaterialInstanceConstant/, `${classPath}: a non-MIC target is rejected by native inheritance`);
  t.assert(!mock.calls.some(call => call.body.functionName?.startsWith('SetMaterialInstance')),
    `${classPath}: an incompatible target is rejected before mutation`);
}

{
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', { Class: '/Script/Test.CustomMaterialInstanceConstant' })
    .on('PUT /remote/object/call', () => { throw new Error('Function call is not allowed'); });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'Roughness', value: 0,
  }, conn), /allow KismetMathLibrary.ClassIsChildOf/, 'denied inheritance probe gives a specific prerequisite error');
  t.assert(!mock.calls.some(call => call.body.functionName?.startsWith('SetMaterialInstance')),
    'denied inheritance probe cannot fall back to an unsafe write');
}

for (const Responses of [[], [
  { ResponseCode: 200 },
  { ResponseCode: 200, ResponseBody: { ParameterNames: [] } },
  { ResponseCode: 200, ResponseBody: { ParameterNames: [] } },
]]) {
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', instanceDescription)
    .on('PUT /remote/batch', { Responses });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  await t.assertRejects(() => executeRcTool('list_material_parameters', { include_details: false, asset_path: asset }, conn),
    /malformed/i, 'missing batch data cannot masquerade as an empty material');
}

{
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', instanceDescription)
    .on('PUT /remote/batch', { Responses: [0, 1, 2].map(() => ({
      ResponseCode: 200, ResponseBody: { ParameterNames: [] },
    })) });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  const result = await executeRcTool('list_material_parameters', { include_details: false, asset_path: asset }, conn);
  t.assert(result.scalar.length + result.vector.length + result.texture.length === 0 && !result._subErrors,
    'a loaded material with no parameters returns clean empty arrays');
}

{
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', instanceDescription)
    .on('PUT /remote/object/call', () => { throw new Error('Function does not exist'); });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'Roughness', value: 0,
  }, conn), /UEMCP 1.0.20\+ plugin/, 'a missing native definition helper requires plugin deployment explicitly');
  t.assert(!mock.calls.some(call => call.body.functionName?.startsWith('SetMaterialInstance')),
    'a missing helper cannot fall back to the unsafe names-only preflight');
}

{
  const rows = [
    { Name: 'Tint', Id: '11111111-2222-3333-4444-555555555555', Association: 'LayerParameter', Index: 0,
      bValueFound: true, VectorValue: { R: 0.1, G: 0.2, B: 0.3, A: 1 } },
    { Name: 'Tint', Id: '66666666-7777-8888-9999-AAAAAAAAAAAA', Association: 'LayerParameter', Index: 1,
      bValueFound: false, VectorValue: { R: 0, G: 0, B: 0, A: 0 } },
  ];
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', instanceDescription)
    .on('PUT /remote/batch', (_port, _method, _path, body) => ({ Responses: body.Requests.map(({ Body }) => ({
      ResponseCode: 200,
      ResponseBody: Body.functionName === 'GetParameterDetails' && Body.objectPath === definitionLibrary
        ? { ReturnValue: Body.parameters.ParameterType === 'Vector' ? rows : [] } : { ParameterNames: ['Tint'] },
    })) }));
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  const result = await executeRcTool('list_material_parameters', { asset_path: asset, include_details: true }, conn);
  t.assert(result.vector.length === 2 && result.vector[0].Index === 0 && result.vector[1].Index === 1,
    'detailed listing preserves duplicate names at different layer indices');
  t.assert(result.vector[0]?.Id === rows[0].Id && result.vector[0]?.Association === 'LayerParameter',
    'detailed listing exposes actual GUID and association');
  t.assert(result.vector[0]?.Value?.G === 0.2 && result.vector[0]?.ValueFound === true,
    'detailed listing decodes effective typed values');
  t.assert(result.vector[1]?.Value === null && result.vector[1]?.ValueFound === false,
    'failed native value lookup is explicit rather than a fabricated default');
  t.assert(result.info_fields.includes('Association') && result.info_fields.includes('Value'),
    'detailed listing advertises identity and value fields');
}

for (const [associatedKind, parameterType, requestedValue] of [
  ['layer', 'scalar', 0.7], ['blend', 'scalar', 0.7],
  ['layer', 'vector', { R: 0.1, G: 0.2, B: 0.3, A: 1 }], ['blend', 'vector', { R: 0.1, G: 0.2, B: 0.3, A: 1 }],
  ['layer', 'texture', '/Game/Textures/T_Test.T_Test'], ['blend', 'texture', '/Game/Textures/T_Test.T_Test'],
]) {
  let written = false;
  const typeName = parameterType[0].toUpperCase() + parameterType.slice(1);
  const associatedName = associatedKind === 'layer' ? 'LayerParameter' : 'BlendParameter';
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', instanceDescription)
    .on('PUT /remote/object/call', (_port, _method, _path, body) => {
      if (body.functionName === 'GetParameterDetails') return { ReturnValue: [0, 1].map(Index => ({
        Name: 'Roughness', Association: associatedName, Index, Id: '11111111-2222-3333-4444-555555555555',
        bValueFound: true, [`${typeName}Value`]: requestedValue,
      })) };
      if (body.functionName === 'SetParameterValue') {
        written = body.parameters.Index === 1 && body.parameters.Association === associatedName
          && body.parameters.ParameterName === 'Roughness';
        return { ReturnValue: written };
      }
      return { ReturnValue: [] };
    })
    .on('PUT /remote/object/property', { [`${typeName}ParameterValues`]: [{
      ParameterInfo: { Name: 'Roughness', Association: associatedKind === 'layer' ? 'Layer Parameter' : 'Blend Parameter', Index: 1 }, ParameterValue: requestedValue,
    }] });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  const result = await executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'roughness', value: requestedValue, association: associatedName, index: 1,
  }, conn).catch(error => ({ error: error.message }));
  t.assert(result.verified === true && written, `${associatedKind} ${parameterType}: setter targets exact identity with canonical FName`);
  t.assert(result.association === associatedKind && result.index === 1, 'verified result reports the exact identity');
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'roughness', value: requestedValue, association: associatedKind,
  }, conn), /index/i, 'a layer write requires an explicit nonnegative index');
}

for (const mode of ['missing-definition', 'rejected-write', 'wrong-readback', 'wrong-index-override']) {
  let writes = 0;
  const mock = new FakeHttpResponder()
    .on('PUT /remote/object/describe', instanceDescription)
    .on('PUT /remote/object/call', (_port, _method, _path, body) => {
      if (body.functionName === 'GetParameterDetails') return { ReturnValue: mode === 'missing-definition' ? [] : [{
        Name: 'Tint', Association: 'BlendParameter', Index: 0, Id: '', bValueFound: true,
        ScalarValue: mode === 'wrong-readback' ? 0.2 : 0.7,
      }] };
      writes++;
      return { ReturnValue: mode !== 'rejected-write' };
    })
    .on('PUT /remote/object/property', { ScalarParameterValues: [{
      ParameterInfo: { Name: 'Tint', Association: 'Blend Parameter', Index: 1 }, ParameterValue: 0.7,
    }] });
  const conn = new ConnectionManager({ rcPort: 30010, httpCommandFn: mock.handler() });
  await t.assertRejects(() => executeRcTool('set_material_parameter', {
    asset_path: asset, parameter_name: 'Tint', value: 0.7, association: 'blend', index: 0,
  }, conn), /not found|rejected|readback|override/, `${mode}: associated write cannot falsely certify success`);
  if (mode === 'missing-definition') t.assert(writes === 0, 'unknown association/index is rejected before mutation');
}

process.exit(t.summary());
