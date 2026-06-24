/**
 * Runtime accessors for database-backed form definitions.
 *
 * The source of truth for form schemas is PostgreSQL app_definitions where
 * category = "form_definition". Do not add request form schemas here.
 * Native runtime and regression tests populate FORM_DEFINITIONS from the live
 * database before these helpers are used.
 */

const FORM_DEFINITIONS = {};

function getFormDefinition_(processOrRequest, formStage) {
  const process =
    processOrRequest && processOrRequest.key
      ? processOrRequest
      : getProcessDefinition_(processOrRequest);
  const formKey = trim_(process.requestForm || process.key);
  const definition = FORM_DEFINITIONS[formKey] || {};
  const stage = trim_(formStage || "request");
  return cloneObject_((definition.forms || {})[stage] || {});
}

function publicFormDefinition_(processOrRequest, formStage) {
  return getFormDefinition_(processOrRequest, formStage);
}

function getAllFormDefinitions_(processOrRequest) {
  const process =
    processOrRequest && processOrRequest.key
      ? processOrRequest
      : getProcessDefinition_(processOrRequest);
  const formKey = trim_(process.requestForm || process.key);
  const definition = FORM_DEFINITIONS[formKey] || {};
  const forms = definition.forms || {};
  const definitions = Object.keys(forms).map(function (stage) {
    return cloneObject_(forms[stage]);
  });

  return definitions.filter(function (item, index) {
    return (
      item &&
      item.key &&
      definitions.findIndex(function (candidate) {
        return candidate && candidate.key === item.key;
      }) === index
    );
  });
}

function getFormAdjustmentFields_(formStage, processOrRequest) {
  const formKey = formStage === "actual" || formStage === "checklist" ? formStage : "request";
  const definition = getFormDefinition_(processOrRequest, formKey);
  const fieldMap = formFieldMap_(definition);
  return (definition.adjustmentFields || [])
    .map(function (spec) {
      const fieldName = typeof spec === "string" ? spec : spec.field;
      if (!fieldName) {
        return null;
      }
      const field = fieldMap[fieldName] || {};
      return {
        field: fieldName,
        label:
          (typeof spec === "object" && spec.label) ||
          field.adjustmentLabel ||
          field.validationLabel ||
          field.label ||
          fieldName,
      };
    })
    .filter(Boolean);
}

function formFieldMap_(definition) {
  const map = {};
  flattenFormFields_(definition).forEach(function (field) {
    if (field.name) {
      map[field.name] = field;
    }
  });
  return map;
}

function flattenFormFields_(definition) {
  const fields = [];
  (definition.sections || []).forEach(function (section) {
    (section.fields || []).forEach(function (field) {
      fields.push(field);
    });
  });
  return fields;
}
