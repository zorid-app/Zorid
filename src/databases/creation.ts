import {BaseDocument} from '../bases/document.ts';
import type {BaseValue} from '../bases/document.ts';
import {inferBaseCreationDefaults,planBaseItemCreation} from '../bases/creation.ts';
import {readProperties,removeProperty} from '../core/properties.ts';
import type {DatabaseCollection} from '../core/databases.ts';
import type {Vault} from '../core/vault.ts';
import {basePropertyName} from '../bases/property-definitions.ts';
import {collectionInitialValues} from './collection-ui.ts';

/** A template supplies copied content, never membership or an existing identity.
 * Valid filter/group hints override template values; invalid hints are omitted. */
export async function planCollectionEntryCreation(options:{vault:Vault;collection:DatabaseCollection;document:BaseDocument;basePath:string;viewIndex:number;group?:{property:string;value:BaseValue};validate:()=>void}){
  const {document,viewIndex,collection}=options,defaults=inferBaseCreationDefaults(document,viewIndex);
  const plan=await planBaseItemCreation(options);options.validate();
  let body=plan.templatePath?plan.text:'';
  const templateValues=plan.templatePath?Object.fromEntries(readProperties(body).map(property=>[property.key,property.value])):{};
  if(plan.templatePath)body=removeProperty(removeProperty(body,'_id'),'_type');
  const values={...collectionInitialValues(collection,templateValues),...collectionInitialValues(collection,{...defaults.properties,...(options.group?{[basePropertyName(options.group.property)]:options.group.value}:{})})};
  return{path:plan.path,body,values,warnings:plan.warnings};
}
