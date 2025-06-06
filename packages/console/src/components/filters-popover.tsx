import { useCallback, useState } from 'react';
import { QueryFilter } from './query-filter';
import {
  Button,
  Code,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
} from '@triplit/ui';
import { nanoid } from 'nanoid';
import {
  Collection,
  DataType,
  SUPPORTED_OPERATIONS,
  type QueryWhere,
  type WhereFilter,
} from '@triplit/db';
import { RoleFilters } from './role-filters.js';
import { TriplitClient } from '@triplit/client';

type FiltersPopoverProps = {
  collection: string;
  onSubmit: (filters: QueryWhere<any, any>) => void;
  uniqueAttributes: Set<string>;
  collectionSchema?: Collection;
  filters: QueryWhere<any, any>;
  client: TriplitClient;
};

function mapFilterArraysToFilterObjects(
  filters: QueryWhere<any, any>,
  collectionSchema?: Collection
) {
  return filters.map(([attribute, operator, value]) => ({
    attribute,
    asType: collectionSchema
      ? collectionSchema?.schema?.properties?.[attribute]?.type
      : typeof value,
    operator,
    value,
    id: nanoid(),
  }));
}

function mapFilterObjectsToFilterArrays(
  filters: {
    attribute: string;
    operator: string;
    value: any;
  }[]
): QueryWhere<any, any> {
  return filters.map(
    ({ attribute, operator, value }) =>
      [attribute, operator, value] as WhereFilter<any, any>
  );
}

export function FiltersPopover(props: FiltersPopoverProps) {
  const { collection, uniqueAttributes, collectionSchema, onSubmit, filters } =
    props;

  const [key, setKey] = useState(+new Date());

  const [draftFilters, setDraftFilters] = useState(
    mapFilterArraysToFilterObjects(props.filters, collectionSchema)
  );
  const onCreateNewDraftFilter = useCallback(
    (attribute: string) => {
      setKey(+new Date());
      const attributeDefinition: DataType | null = collectionSchema
        ? collectionSchema?.schema?.properties?.[attribute]
        : null;
      const defaultType = attributeDefinition?.type ?? 'string';
      const defaultOperator = SUPPORTED_OPERATIONS[defaultType][0];
      const defaultValue = defaultType === 'boolean' ? true : '';

      const filterObj = {
        attribute,
        asType: defaultType,
        operator: defaultOperator,
        value: defaultValue,
        id: nanoid(),
      };
      setDraftFilters((prev) => [...prev, filterObj]);
    },
    [collectionSchema]
  );
  const filterAttributes = Array.from(
    collectionSchema
      ? Object.entries(collectionSchema.schema.properties).reduce(
          (prev, [name, def]) => {
            if (def.type !== 'query') prev.push(name);
            return prev;
          },
          [] as string[]
        )
      : uniqueAttributes
  ).sort((a, b) => a.localeCompare(b));
  const hasFilters = filters.length > 0;
  return (
    <Popover
      onOpenChange={() =>
        setDraftFilters(
          mapFilterArraysToFilterObjects(filters, collectionSchema)
        )
      }
    >
      <PopoverTrigger asChild>
        <Button
          size={'sm'}
          variant={'secondary'}
          className={`${
            hasFilters
              ? 'bg-blue-300 hover:bg-blue-200 dark:bg-blue-500 dark:hover:bg-blue-600'
              : ''
          } py-1 h-auto`}
        >
          <span className="mr-2">Filters</span>
          <span className={hasFilters ? '' : 'text-zinc-500'}>
            {filters.length}
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="flex flex-col gap-3 w-auto">
        {draftFilters.length > 0 ? (
          <div
            className={`grid ${
              collectionSchema ? 'grid-cols-9' : 'grid-cols-11'
            } gap-2`}
          >
            {draftFilters.map((data, index) => (
              <QueryFilter
                key={data.id}
                filter={data}
                onUpdate={(filterField, newValue) => {
                  setDraftFilters((prev) =>
                    prev.map((filter) => {
                      if (filter.id === data.id) {
                        return { ...filter, [filterField]: newValue };
                      }
                      return filter;
                    })
                  );
                }}
                attributes={filterAttributes}
                collectionDefinition={collectionSchema}
                onPressRemove={() => {
                  setDraftFilters((prev) =>
                    prev.filter((f) => f.id !== data.id)
                  );
                }}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground truncate">
            No filters applied to <Code>{collection}</Code>
          </p>
        )}
        <form
          className="flex flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(mapFilterObjectsToFilterArrays(draftFilters));
          }}
        >
          <Select
            key={key}
            placeholder="Add Filter"
            disabled={filterAttributes.length === 0}
            onValueChange={onCreateNewDraftFilter}
            data={filterAttributes}
          />
          <Button type="submit">Apply</Button>
        </form>
        {collectionSchema?.permissions && (
          <RoleFilters
            permissions={collectionSchema?.permissions}
            rule="read"
            client={props.client}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
